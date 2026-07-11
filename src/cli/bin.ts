#!/usr/bin/env node
//
// memwarden CLI.
//
//   memwarden connect [tool]       # wire an MCP client to the local brain
//   memwarden export <file>        # write a portable Brain Bundle
//   memwarden import <file>        # load a Brain Bundle into the daemon
//
// connect writes ./.mcp.json so any MCP client shares the one local brain;
// export/import move your memory between machines via the daemon's API.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  writeMcpConfig,
  mcpConfigPathFor,
  buildMcpServerEntry,
  writeClaudeHooks,
  removeClaudeHooks,
  claudeSettingsPathFor,
} from "./connect.js";
import {
  TOOLS,
  writeTool,
  unwireTool,
  toolWireState,
  writeAgentsMd,
  removeAgentsMd,
  type LaunchInfo,
} from "./tools.js";
import { HOST_HOOKS, hostHookById, hooklessToolIds } from "./host-hooks.js";
import {
  runningProcessNames,
  toolRunState,
  restartAdvice,
} from "./running.js";
import {
  handleSessionStart,
  handleCapture,
  readStdin,
  isHookHost,
  type HookHost,
} from "./hook.js";
import { ensureDaemon, daemonAlive, DAEMON_ENTRY } from "../daemon/ensure.js";
import { installService, uninstallService } from "../daemon/service.js";
import { getSecret } from "../functions/config.js";

const DAEMON_URL = process.env.MEMWARDEN_URL ?? "http://localhost:3111";

// Absolute paths to the installed CLI and MCP bins. The configs/hooks/service
// we write bake these in, so they must point at a STABLE install — a global
// (`npm i -g memwarden`) or a project-local `node_modules/.bin`. dist/cli/bin.js -> here.
const SELF = fileURLToPath(import.meta.url);
const MCP_BIN = join(dirname(SELF), "..", "mcp", "bin.js");
const HOOK_BASE = `"${process.execPath}" "${SELF}"`;

// True when this CLI is running out of npm's transient npx cache
// (`~/.npm/_npx/<hash>/…`). That directory is garbage-collected, so any
// absolute path we bake from it (MCP command, Claude hooks, the daemon
// service unit) silently breaks once the cache is evicted. `up`/`connect`
// wire long-lived integrations, so they must refuse to run from there and
// point the user at a stable install. The one-shot `audit` needs nothing
// persistent, so it is exempt.
function runningFromNpxCache(): boolean {
  return /[\\/]_npx[\\/]/.test(SELF);
}

function requireStableInstall(cmd: string): boolean {
  if (!runningFromNpxCache()) return true;
  console.error(
    `\n[memwarden] '${cmd}' wires long-lived hooks, MCP servers, and a self-healing\n` +
      `daemon that need a stable install — but this is running from npx's transient\n` +
      `cache, which npm deletes later (the wiring would break). Install it first:\n\n` +
      `    npm install -g memwarden\n` +
      `    memwarden ${cmd}\n\n` +
      `(The zero-install \`npx memwarden audit <store>\` needs none of this.)\n`,
  );
  return false;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  // getSecret() resolves env first, then the persisted <dataDir>/secret file —
  // so CLI commands run from a plain shell still authenticate to a secured daemon.
  const secret = getSecret();
  if (secret) h["authorization"] = `Bearer ${secret}`;
  return h;
}

// The CLI persists the generated secret here so repeat `up` runs reuse the same
// value (re-generating would orphan already-wired clients). The DAEMON resolves
// its secret from the MEMWARDEN_SECRET env var (config.ts getSecret), so `up`
// loads this file into process.env and bakes it into the service environment —
// the file is the CLI's source of truth, the env var is the runtime mechanism.
function secretFilePath(dataDir: string): string {
  return join(dataDir, "secret");
}

function readPersistedSecret(dataDir: string): string | undefined {
  const path = secretFilePath(dataDir);
  if (!existsSync(path)) return undefined;
  try {
    const s = readFileSync(path, "utf8").trim();
    return s || undefined;
  } catch {
    return undefined;
  }
}

function persistSecret(dataDir: string, secret: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    // The brain dir holds memories, the secret, and the oplog — owner-only.
    chmodSync(dataDir, 0o700);
  } catch {
    // best-effort; the write below surfaces a real error
  }
  const path = secretFilePath(dataDir);
  writeFileSync(path, secret + "\n", "utf8");
  // Owner read/write only — this is a credential.
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod can fail on some filesystems; the secret is still written
  }
}

/**
 * Resolve the API secret for `up`, generating one on first run. Priority:
 *   1. an explicit --secret flag,
 *   2. MEMWARDEN_SECRET already in the environment,
 *   3. a previously-persisted secret under the data dir,
 *   4. a freshly generated 32-byte random secret (persisted for next time).
 * The resolved value is written back into process.env so any daemon spawned by
 * ensureDaemon (which copies process.env) and every wired client inherit it.
 */
function resolveSecret(
  flagSecret: string | undefined,
  dataDir: string,
): { secret: string; generated: boolean } {
  const existing =
    (flagSecret && flagSecret.trim()) ||
    (process.env.MEMWARDEN_SECRET && process.env.MEMWARDEN_SECRET.trim()) ||
    readPersistedSecret(dataDir);
  let secret: string;
  let generated = false;
  if (existing) {
    secret = existing;
  } else {
    secret = randomBytes(32).toString("base64url");
    generated = true;
  }
  persistSecret(dataDir, secret);
  // Propagate to this process so the detached daemon spawn (ensureDaemon copies
  // process.env) enforces it, and so authHeaders() can call the daemon.
  process.env.MEMWARDEN_SECRET = secret;
  return { secret, generated };
}

function parseFlags(argv: string[]): {
  target: string;
  url: string | undefined;
  secret: string | undefined;
} {
  let target = "claude-code";
  let url: string | undefined;
  let secret: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") url = argv[++i];
    else if (a === "--secret") secret = argv[++i];
    else if (a && !a.startsWith("--")) target = a;
  }
  return { target, url, secret };
}

function connect(rest: string[]): void {
  if (!requireStableInstall("connect")) {
    process.exitCode = 1;
    return;
  }
  const { target, url, secret } = parseFlags(rest);
  const withHooks = rest.includes("--with-hooks");
  // Launch the local built MCP bin so the config works before publish.
  const opts = {
    ...(url ? { url } : {}),
    ...(secret ? { secret } : {}),
    mcpCommand: process.execPath,
    mcpArgs: [MCP_BIN],
  };
  const path = mcpConfigPathFor(target, process.cwd());
  const { created } = writeMcpConfig(path, opts);
  console.log(
    `[memwarden] ${created ? "wrote" : "updated"} ${path} — '${target}' now shares the local brain.`,
  );

  if (withHooks) {
    const settings = claudeSettingsPathFor(process.cwd());
    writeClaudeHooks(settings, HOOK_BASE);
    console.log(
      `[memwarden] wrote ${settings} — SessionStart auto-injects this project's memory; PostToolUse auto-captures.`,
    );
  } else {
    console.log(
      `[memwarden] tip: add --with-hooks to auto-inject context on session start and capture automatically.`,
    );
  }
}

async function hook(rest: string[]): Promise<void> {
  const event = rest[0];
  // --host <id> selects the host dialect (stdin parsing + reply schema).
  // An unknown host degrades to the claude-code dialect rather than failing:
  // a hook must never be the thing that breaks an agent's turn.
  const hostIdx = rest.indexOf("--host");
  const hostArg = hostIdx >= 0 ? rest[hostIdx + 1] : undefined;
  const host: HookHost =
    hostArg && isHookHost(hostArg) ? hostArg : "claude-code";
  if (hostArg && !isHookHost(hostArg)) {
    console.error(`[memwarden] unknown hook host '${hostArg}' — using claude-code dialect`);
  }
  const raw = await readStdin();
  const secret = getSecret();
  const deps = {
    baseUrl: DAEMON_URL,
    host,
    ...(secret ? { secret } : {}),
  };
  let out = "";
  if (event === "session-start") out = await handleSessionStart(raw, deps);
  else if (event === "capture") out = await handleCapture(raw, deps);
  if (out) process.stdout.write(out);
}

async function exportBrain(file: string | undefined): Promise<void> {
  if (!file) throw new Error("usage: memwarden export <file>");
  const res = await fetch(`${DAEMON_URL}/memwarden/export`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`export failed: HTTP ${res.status}`);
  const bundle = (await res.json()) as { sessions?: unknown[] };
  writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n", "utf8");
  console.log(
    `[memwarden] exported brain to ${file} (${bundle.sessions?.length ?? 0} sessions).`,
  );
}

async function doctor(rest: string[]): Promise<void> {
  const path = rest.find((a) => !a.startsWith("--")) ?? ".";
  const root = path === "." ? process.cwd() : path;
  // Scope the audit to THIS project by default so `doctor .` in repo A never
  // pools stale/conflict findings against unrelated repos. project is derived
  // the same way the capture path does it: the project IS the cwd/root (see
  // cli/hook.ts, which sends `project: cwd`). Pass --all-projects for a
  // whole-brain audit across every project.
  const allProjects = rest.includes("--all-projects");
  const body: { root: string; project?: string } = { root };
  if (!allProjects) body.project = root;
  const res = await fetch(`${DAEMON_URL}/memwarden/doctor`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`doctor failed: HTTP ${res.status}`);
  const r = (await res.json()) as {
    total: number;
    safe: number;
    verified: number;
    sourcedUnverified: number;
    stale: Array<{ title: string; reason: string }>;
    unsourced: Array<{ title: string; reason: string }>;
    conflicts: Array<{
      olderTitle: string;
      newerTitle: string;
      subject: string;
      reason: string;
    }>;
    footprint?: { bytesOnDisk: number; dataDir: string; oplogEntries: number };
  };
  console.log(
    `\nmemwarden doctor — ${root}${allProjects ? " (all projects)" : " (this project)"}\n`,
  );
  console.log(`  VERIFIED:        ${r.verified} memories (code-backed, current)`);
  console.log(`  SOURCED:         ${r.sourcedUnverified} memories (sourced, not content-verified)`);
  console.log(`  STALE:           ${r.stale.length} memories reference files that changed/deleted`);
  console.log(`  UNSOURCED:       ${r.unsourced.length} memories have no evidence`);
  console.log(`  CONFLICTS:       ${r.conflicts.length} possible contradictions\n`);
  for (const s of r.stale.slice(0, 5)) console.log(`  [stale]     ${s.title} — ${s.reason}`);
  for (const u of r.unsourced.slice(0, 5)) console.log(`  [unsourced] ${u.title} — ${u.reason}`);
  for (const c of r.conflicts.slice(0, 5)) {
    console.log(
      `  [conflict] ${c.newerTitle} may contradict ${c.olderTitle} — ${c.reason}`,
    );
  }
  if (r.footprint) {
    const mb = r.footprint.bytesOnDisk / (1024 * 1024);
    const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(r.footprint.bytesOnDisk / 1024)} KB`;
    console.log(
      `\n  FOOTPRINT:       ${size} on disk at ${r.footprint.dataDir} · ${r.footprint.oplogEntries} oplog entries`,
    );
  }
  console.log(`\n  ${r.total} memories audited.\n`);
}

// memwarden forget <obsId> — delete one memory and print the tamper-evident
// receipt: the oplog entries proving the write and the delete, chain status,
// and a hash over the receipt itself. An id that doesn't exist reports
// exactly that — never a fake success. --erase additionally nulls the
// memory's oplog payloads in place (chain-safe on v2 entries; points at
// `memwarden compact` when legacy v1 entries block it).
async function forget(rest: string[]): Promise<void> {
  const obsId = rest.find((a) => !a.startsWith("--"));
  if (!obsId) throw new Error("usage: memwarden forget <observationId> [--erase] [--json]");
  const erase = rest.includes("--erase");
  const res = await fetch(`${DAEMON_URL}/memwarden/forget`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ observation_id: obsId, erase }),
  });
  if (!res.ok) throw new Error(`forget failed: HTTP ${res.status}`);
  const r = (await res.json()) as {
    deleted: boolean;
    reason?: string;
    eraseBlocked?: string;
    receipt?: {
      obsId: string;
      title: string;
      deletedAt: string;
      deleteEntry: { id: number; ts: string; hash: string } | null;
      createEntry: { id: number; ts: string; hash: string } | null;
      chainIntact: boolean;
      contentErased: boolean;
      receiptHash: string;
    };
  };
  if (rest.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (!r.deleted) {
    console.log(`\n  Not deleted: ${r.reason ?? "unknown reason"}\n`);
    process.exitCode = 1;
    return;
  }
  const rec = r.receipt!;
  console.log(`\n  Deleted "${rec.title}" (${rec.obsId})\n`);
  if (rec.contentErased) {
    console.log(
      `  Removed from the active store, search, recall, and every index — and its\n` +
        `  content was erased from the oplog in place (the chain still verifies:\n` +
        `  entry hashes cover the content's hash, which stays as the commitment).\n`,
    );
  } else if (r.eraseBlocked) {
    console.log(
      `  Removed from the active store, search, recall, and every index.\n` +
        `  Erase was requested but blocked: ${r.eraseBlocked}.\n`,
    );
  } else {
    console.log(
      `  Removed from the active store, search, recall, and every index.\n` +
        `  Honest scope: the original content remains inside the local append-only\n` +
        `  oplog (that is what makes the history tamper-evident). To erase it too,\n` +
        `  use \`memwarden forget <id> --erase\`, or \`memwarden compact\` to erase\n` +
        `  every already-forgotten memory and shrink the store.\n`,
    );
  }
  console.log(`  delete receipt`);
  if (rec.createEntry) {
    console.log(`    written   oplog #${rec.createEntry.id} at ${rec.createEntry.ts}`);
    console.log(`              hash ${rec.createEntry.hash.slice(0, 16)}…`);
  }
  if (rec.deleteEntry) {
    console.log(`    deleted   oplog #${rec.deleteEntry.id} at ${rec.deleteEntry.ts}`);
    console.log(`              hash ${rec.deleteEntry.hash.slice(0, 16)}…`);
  }
  console.log(`    chain     ${rec.chainIntact ? "intact (verified end to end)" : "BROKEN — run memwarden doctor"}`);
  console.log(`    erased    ${rec.contentErased ? "yes — content removed from the oplog" : "no — content still in the oplog"}`);
  console.log(`    receipt   ${rec.receiptHash}`);
  console.log(
    `\n  The deletion is recorded in the hash-chained oplog: removing or editing\n` +
      `  the record would break the chain. Keep --json output as a shareable proof\n` +
      `  the deletion happened (it contains hashes, never the deleted content).\n`,
  );
}

// memwarden compact — one-shot oplog migration + shrink. Re-chains every
// entry as chain v2 (hashes cover the content's hash, not the content),
// erases the payloads of already-forgotten memories, anchors the old head
// hash in a compact record, and VACUUMs the database file.
async function compact(rest: string[]): Promise<void> {
  const dryRun = rest.includes("--dry-run");
  const res = await fetch(`${DAEMON_URL}/memwarden/compact`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ dry_run: dryRun }),
  });
  if (!res.ok) throw new Error(`compact failed: HTTP ${res.status}`);
  const r = (await res.json()) as {
    entriesRewritten: number;
    erasedCount: number;
    previousHeadHash: string;
    compactedAt: string;
    dryRun: boolean;
    vacuum: { ok: boolean; bytesReclaimed: number | null; detail?: string };
  };
  if (rest.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`\n  memwarden compact${r.dryRun ? " (dry run — nothing was written)" : ""}\n`);
  console.log(`    entries rewritten   ${r.entriesRewritten}`);
  console.log(`    payloads erased     ${r.erasedCount} (forgotten memories only — live data untouched)`);
  console.log(
    `    previous head hash  ${r.previousHeadHash ? r.previousHeadHash : "(empty chain)"}${
      r.dryRun ? "" : "\n                        anchored in the new chain's compact record"
    }`,
  );
  if (r.dryRun) {
    console.log(`    vacuum              skipped (dry run)`);
  } else if (r.vacuum.ok) {
    console.log(
      `    vacuum              ok${
        r.vacuum.bytesReclaimed === null
          ? ""
          : ` — ${formatBytes(r.vacuum.bytesReclaimed)} reclaimed`
      }`,
    );
  } else {
    console.log(`    vacuum              FAILED — ${r.vacuum.detail ?? "unknown"} (erasure still applied)`);
  }
  console.log(
    `\n  After compact every entry is chain v2: future \`memwarden forget --erase\`\n` +
      `  erases in place without breaking the chain. Receipts issued before this\n` +
      `  compaction cite pre-compaction hashes; their chain's head hash is the\n` +
      `  previousHeadHash anchored above.\n`,
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${n} B`;
}

// memwarden exclude/include — per-project firewall holes. An excluded
// project is invisible to every automatic surface: no capture, no
// injection, hooks and proxy alike. Takes effect immediately (the list is
// re-read per request), no daemon restart.
function excludedListPath(): string {
  const dataDir = process.env.MEMWARDEN_DATA_DIR ?? join(homedir(), ".memwarden");
  return join(dataDir, "excluded");
}

function readExcluded(): string[] {
  const path = excludedListPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function writeExcluded(lines: string[]): void {
  const path = excludedListPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
}

function exclude(rest: string[]): void {
  if (rest.includes("--list")) {
    const lines = readExcluded();
    if (lines.length === 0) {
      console.log("[memwarden] no excluded projects.");
      return;
    }
    console.log("[memwarden] excluded projects (no capture, no injection):");
    for (const l of lines) console.log(`  ${l}`);
    return;
  }
  const target = resolve(rest.find((a) => !a.startsWith("--")) ?? process.cwd());
  const lines = readExcluded();
  if (lines.includes(target)) {
    console.log(`[memwarden] already excluded: ${target}`);
    return;
  }
  writeExcluded([...lines, target]);
  console.log(
    `[memwarden] excluded ${target} — memwarden will not capture from or inject into this project. Undo: memwarden include ${target}`,
  );
}

function include(rest: string[]): void {
  const target = resolve(rest.find((a) => !a.startsWith("--")) ?? process.cwd());
  const lines = readExcluded();
  const next = lines.filter((l) => resolve(l) !== target);
  if (next.length === lines.length) {
    console.log(`[memwarden] not excluded: ${target}`);
    return;
  }
  writeExcluded(next);
  console.log(`[memwarden] re-included ${target}.`);
}

// memwarden audit <store> — run the memory doctor against a FOREIGN store
// (claude-mem/any SQLite, CLAUDE.md piles, Mem0-style JSON exports) without a
// daemon or any setup. `npx memwarden audit ~/.claude-mem/claude-mem.db` is
// the whole onboarding.
async function audit(rest: string[]): Promise<void> {
  const { auditStore, buildAuditPlan, renderAuditHtml } = await import("../functions/audit.js");

  // --root and --html each consume the following arg as a value (--html's is
  // optional); mark those indices so they aren't mistaken for the positional
  // store path.
  const consumed = new Set<number>();
  const rootIdx = rest.indexOf("--root");
  const root =
    rootIdx >= 0 && rest[rootIdx + 1] && !rest[rootIdx + 1]!.startsWith("--")
      ? ((consumed.add(rootIdx + 1), rest[rootIdx + 1]) as string)
      : process.cwd();

  const htmlIdx = rest.indexOf("--html");
  let htmlOut: string | undefined;
  if (htmlIdx >= 0) {
    const next = rest[htmlIdx + 1];
    if (next && !next.startsWith("--")) {
      htmlOut = next;
      consumed.add(htmlIdx + 1);
    } else {
      htmlOut = "memwarden-audit.html";
    }
  }

  const positional = rest.filter(
    (a, i) => !a.startsWith("--") && !consumed.has(i),
  );
  const storePath = positional[0];
  if (!storePath) {
    throw new Error(
      "usage: memwarden audit <store.db|store.json|CLAUDE.md|dir> [--root repo] [--json] [--html [out.html]]",
    );
  }
  const report = await auditStore(storePath, root);

  if (htmlOut) {
    writeFileSync(htmlOut, renderAuditHtml(report), "utf8");
    console.log(`[memwarden] wrote shareable audit report to ${htmlOut}`);
    if (!rest.includes("--json")) return;
  }

  if (rest.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const tty = process.stdout.isTTY === true;
  const paint = (code: string, s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red = (s: string): string => paint("31", s);
  const yellow = (s: string): string => paint("33", s);
  const green = (s: string): string => paint("32", s);
  const gray = (s: string): string => paint("90", s);
  const bold = (s: string): string => paint("1", s);

  const pct = (n: number): string =>
    report.total > 0 ? `${Math.round((n / report.total) * 100)}%` : "0%";
  const row = (label: string, n: number, note: string): string =>
    `  ${label.padEnd(12)} ${String(n).padStart(5)}  ${pct(n).padStart(4)}   ${note}`;

  console.log(`\n${bold("memwarden audit")} — ${report.store} (${report.kind})`);
  console.log(`${" ".repeat(18)}vs ${report.root}\n`);
  console.log(
    `  ${report.total} memories scanned · ${report.anchored} anchored to ${report.uniqueFiles} file(s)\n`,
  );
  console.log(row(red("MISSING"), report.missing.length, "reference files that no longer exist"));
  console.log(
    row(
      yellow("DRIFTED"),
      report.drifted.length,
      report.driftCheckable
        ? "files changed after the memory was recorded"
        : gray("not checkable — this store records no timestamps"),
    ),
  );
  console.log(row(green("PRESENT"), report.present, "files exist — existence is this store's best case"));
  console.log(row(gray("UNANCHORED"), report.unanchored, "no file evidence at all"));
  console.log("");
  for (const f of report.missing.slice(0, 5)) {
    console.log(`  ${red("[missing]")} ${f.title} — ${f.detail}`);
  }
  for (const f of report.drifted.slice(0, 5)) {
    console.log(`  ${yellow("[drifted]")} ${f.title} — ${f.detail}`);
  }
  if (report.missing.length > 0 || report.drifted.length > 0) console.log("");

  const plan = report.plan ?? buildAuditPlan(report);
  if (plan.length > 0) {
    console.log(`  ${bold("Action plan")}`);
    for (const item of plan.slice(0, 5)) {
      const label =
        item.priority === "critical"
          ? red(item.priority.toUpperCase())
          : item.priority === "high"
            ? yellow(item.priority.toUpperCase())
            : item.priority === "low"
              ? gray(item.priority.toUpperCase())
              : item.priority.toUpperCase();
      console.log(`  [${label}] ${item.title}`);
      console.log(`      ${item.detail}`);
      if (item.command) console.log(`      ${gray(item.command)}`);
    }
    console.log("");
  }

  const badCount = report.missing.length + report.drifted.length;
  if (report.anchored > 0) {
    const badPct = Math.round((badCount / report.anchored) * 100);
    console.log(
      `  ${bold(`${badCount} of ${report.anchored}`)} anchored memories (${badPct}%) are red or yellow: under\n` +
        `  memwarden's Verified Recall they would be classified STALE and never\n` +
        `  injected. PRESENT still isn't "verified" — that requires capture-time\n` +
        `  content hashes, which this store does not record.\n`,
    );
  } else {
    console.log(
      `  Nothing in this store references a file at all — none of it can be\n` +
        `  verified against the code. memwarden records file provenance with\n` +
        `  content hashes at capture, so recall can prove what is still true.\n`,
    );
  }
}

// memwarden dejafix lookup|record — the cross-agent "don't re-solve a fixed
// error" surface, scriptable from the shell. Error text comes from stdin (so you
// can pipe a failing command's output straight in) or trailing args.
async function dejafix(rest: string[]): Promise<void> {
  const sub = rest[0];
  const flags = rest.slice(1);
  const flagVal = (name: string): string | undefined => {
    const i = flags.indexOf(name);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  const cwd = flagVal("--cwd") ?? process.cwd();
  const positional = flags.filter((a, i) => !a.startsWith("--") && !(i > 0 && flags[i - 1]?.startsWith("--")));
  const piped = process.stdin.isTTY ? "" : await readStdin();
  const errorText = (piped.trim() || positional.join(" ")).trim();

  if (sub === "lookup") {
    if (!errorText) throw new Error("usage: memwarden dejafix lookup [--cwd dir] < error.txt");
    const res = await fetch(`${DAEMON_URL}/memwarden/dejafix/lookup`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ error_text: errorText, cwd }),
    });
    if (!res.ok) throw new Error(`dejafix lookup failed: HTTP ${res.status}`);
    const r = (await res.json()) as {
      signature: string | null;
      fixes: Array<{ fix: string; rootCause?: string; tool?: string; timestamp: string; badge: string }>;
    };
    if (!r.signature) {
      console.log("\n  No error signature found in the input.\n");
      return;
    }
    console.log(`\nDéjà Fix — signature: ${r.signature}\n`);
    if (r.fixes.length === 0) {
      console.log("  No verified prior fix for this error in this project.\n");
      return;
    }
    for (const f of r.fixes) {
      const who = f.tool ? `${f.tool}, ` : "";
      console.log(`  [${f.badge}] (${who}${f.timestamp.slice(0, 10)})`);
      if (f.rootCause) console.log(`    root cause: ${f.rootCause}`);
      console.log(`    fix: ${f.fix}\n`);
    }
    return;
  }

  if (sub === "record") {
    const fix = flagVal("--fix");
    if (!fix) throw new Error('usage: memwarden dejafix record --fix "<what fixed it>" [--root-cause s] [--file f]... [--cwd dir] < error.txt');
    if (!errorText) throw new Error("dejafix record needs the error text (pipe it in or pass it as args)");
    const files: string[] = [];
    for (let i = 0; i < flags.length; i++) if (flags[i] === "--file" && flags[i + 1]) files.push(flags[i + 1] as string);
    const body: Record<string, unknown> = { error_text: errorText, fix, cwd };
    const rootCause = flagVal("--root-cause");
    if (rootCause) body["root_cause"] = rootCause;
    if (files.length > 0) body["files"] = files;
    const res = await fetch(`${DAEMON_URL}/memwarden/dejafix/record`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`dejafix record failed: HTTP ${res.status}`);
    const r = (await res.json()) as { recorded: boolean; signature?: string };
    console.log(
      r.recorded
        ? `\n  Recorded fix for signature: ${r.signature}\n`
        : "\n  Nothing recorded (no error signature could be derived).\n",
    );
    return;
  }

  throw new Error("usage: memwarden dejafix <lookup|record> …");
}

async function importBrain(file: string | undefined): Promise<void> {
  if (!file) throw new Error("usage: memwarden import <file>");
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(`${DAEMON_URL}/memwarden/import`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(bundle),
  });
  const out = (await res.json()) as { imported?: unknown };
  if (!res.ok) throw new Error(`import failed: ${JSON.stringify(out)}`);
  console.log(`[memwarden] imported brain from ${file}:`, out.imported);
}

// --- `memwarden up` -----------------------------------------------

async function up(rest: string[]): Promise<void> {
  if (!requireStableInstall("up")) {
    process.exitCode = 1;
    return;
  }
  const { url, secret: flagSecret } = parseFlags(rest);
  const daemonUrl = url ?? DAEMON_URL;
  const home = homedir();
  const all = rest.includes("--all");
  const dataDir = process.env.MEMWARDEN_DATA_DIR ?? join(home, ".memwarden");

  console.log(`\nmemwarden up\n`);

  // 0. secret — generate one on first run (defense-in-depth alongside the
  //    Host-header firewall). resolveSecret persists it under the data dir,
  //    reuses an existing one across runs, and puts it in process.env so the
  //    detached daemon spawn inherits it and the service install can bake it in.
  const { secret, generated } = resolveSecret(flagSecret, dataDir);
  console.log(
    `  secret    ✓ ${generated ? "generated" : "loaded"} (${secretFilePath(dataDir)})`,
  );

  // 0.5. semantic runtime — install transformers.js into <dataDir>/runtime
  //      so recall is semantic, not lexical-only, after a plain npm install.
  //      Runs BEFORE the daemon starts so the daemon boots with it available.
  //      Skippable (--lexical-only / MEMWARDEN_EMBEDDING_PROVIDER=none) and
  //      never fatal: on failure the daemon honestly reports BM25-only.
  const embeddingOff =
    rest.includes("--lexical-only") ||
    (process.env.MEMWARDEN_EMBEDDING_PROVIDER ?? "local").trim().toLowerCase() ===
      "none";
  if (embeddingOff) {
    console.log("  semantic  - skipped (lexical-only requested)");
  } else {
    const { LocalEmbeddingProvider } = await import(
      "../embedding/local-embedding.js"
    );
    if (await LocalEmbeddingProvider.isAvailable()) {
      console.log("  semantic  ✓ local embeddings ready (all-MiniLM-L6-v2)");
    } else {
      console.log(
        "  semantic  … installing local embedding runtime (one time, ~250MB; the\n" +
          "              23MB model downloads on first use — all local, nothing\n" +
          "              leaves this machine)",
      );
      const { installSemanticRuntime } = await import("../embedding/runtime.js");
      const inst = installSemanticRuntime(dataDir);
      console.log(
        inst.ok
          ? `  semantic  ✓ installed (${inst.message})`
          : `  semantic  ⚠ install failed (${inst.message}) — recall runs\n` +
              `              lexical-only (BM25). Retry later with: memwarden up`,
      );
    }
  }

  // 1. daemon — install a self-healing OS service (starts at login, restarts
  //    on crash). Fall back to a detached spawn if there's no service manager.
  //    Either way the wiring continues; the configs point at this daemon.
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));
  const svc = installService(dataDir, secret);
  if (svc.ok) {
    let alive = await daemonAlive(daemonUrl);
    for (let i = 0; i < 40 && !alive; i++) {
      await sleep(250);
      alive = await daemonAlive(daemonUrl);
    }
    console.log(
      `  daemon    ${alive ? "✓" : "⚠"} ${daemonUrl}  ${svc.kind}: ${svc.message}` +
        (alive ? `  brain: ${dataDir}` : "  (starting…)"),
    );
  } else {
    const state = await ensureDaemon(daemonUrl, dataDir);
    if (state === "failed") {
      console.log(
        `  daemon    ⚠ could not start at ${daemonUrl} (port in use?). ` +
          `Wiring tools anyway; start it with: node ${DAEMON_ENTRY}`,
      );
    } else {
      const note =
        svc.kind === "unsupported"
          ? process.platform === "win32"
            ? "Windows service supervision is not supported yet — the daemon runs " +
              "for this login session and self-heals on next use; rerun `memwarden up` after a reboot"
            : "background"
          : `service skipped: ${svc.message}`;
      console.log(`  daemon    ✓ ${daemonUrl}  brain: ${dataDir} (${note})`);
    }
  }

  // 2. wire each detected tool's MCP config (point it at this daemon)
  const launch: LaunchInfo = {
    command: process.execPath,
    args: [MCP_BIN],
    env: {
      MEMWARDEN_URL: daemonUrl,
      ...(secret ? { MEMWARDEN_SECRET: secret } : {}),
    },
  };
  const targets = all ? TOOLS : TOOLS.filter((t) => t.detect(home));

  console.log("");
  if (targets.length === 0) {
    console.log(
      "  no supported tools detected. Re-run with --all to wire them all anyway.",
    );
  } else {
    console.log(`  wiring ${targets.length} tool(s) (MCP):`);
    for (const t of targets) {
      const r = writeTool(t, home, launch);
      if (r.status === "skipped") {
        console.log(`    - ${t.label.padEnd(13)} skipped (${r.reason})`);
        continue;
      }
      console.log(`    ✓ ${t.label.padEnd(13)} ${r.path}`);
    }
  }

  // 3. native lifecycle hooks — mechanical auto inject + auto capture for
  //    every host with a hook (or plugin) system, not just Claude Code.
  const hookHosts = all ? HOST_HOOKS : HOST_HOOKS.filter((h) => h.detect(home));
  if (hookHosts.length > 0) {
    console.log("");
    console.log("  hooks (mechanical auto inject + auto capture):");
    for (const h of hookHosts) {
      const results = h.write(home, HOOK_BASE);
      for (const r of results) {
        if (r.status === "wired") {
          console.log(`    ✓ ${h.label.padEnd(13)} ${r.path}`);
        } else {
          console.log(`    - ${h.label.padEnd(13)} skipped (${r.reason ?? "no change"})`);
        }
      }
      if (h.note && results.some((r) => r.status === "wired")) {
        console.log(`      ${" ".repeat(13)} note: ${h.note}`);
      }
    }
  }

  // 4. AGENTS.md fallback: ONLY for detected tools that got no hook adapter
  //    (instruction-following is the last resort, hooks are the mechanism).
  //    --agents-md forces it for every tool.
  const wantAgentsMd = rest.includes("--agents-md");
  const hooklessIds = hooklessToolIds(targets.map((t) => t.id));
  const hookless = targets.filter((t) => hooklessIds.includes(t.id));
  if (wantAgentsMd || hookless.length > 0) {
    const agents = writeAgentsMd(process.cwd());
    console.log("");
    console.log(
      `  AGENTS.md ✓ ${agents.created ? "wrote" : "updated"} ${agents.path}` +
        (wantAgentsMd
          ? ""
          : ` (fallback for ${hookless.map((t) => t.label).join(", ")} — no hook system)`),
    );
  }

  // 5. restart truth, per tool — auto-discovered from the live process
  //    table instead of a blanket "restart everything". memwarden never
  //    restarts an agent itself: killing a live session to load a config
  //    would be a worse failure than the one it fixes.
  const procs = runningProcessNames();
  console.log("");
  console.log("  what actually needs a restart:");
  for (const t of targets) {
    const state = toolRunState(t.id, procs);
    console.log(`    ${state === "running" ? "⟳" : "✓"} ${t.label.padEnd(13)} ${restartAdvice(t.id, state)}`);
  }

  console.log(
    `\n  Done. Capture and recall are mechanical wherever hooks were written\n` +
      `  above; type /recall in any tool to force it. Check what is actually\n` +
      `  flowing with: memwarden status\n`,
  );
}

// Relative-time formatting for the heartbeat column of `memwarden status`.
function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 5_000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function down(rest: string[]): void {
  const all = rest.includes("--all");
  const purgeData = rest.includes("--data");
  const home = homedir();
  const dataDir = process.env.MEMWARDEN_DATA_DIR ?? join(home, ".memwarden");

  const r = uninstallService();
  if (r.ok) {
    console.log(`[memwarden] stopped and removed the ${r.kind} service.`);
  } else {
    console.log(
      `[memwarden] no service to remove (${r.message}). ` +
        `A daemon started in the background will exit when you log out.`,
    );
  }

  if (!all) {
    console.log(
      `[memwarden] MCP entries, hooks, and AGENTS.md blocks were left in\n` +
        `place (so 'memwarden up' restores instantly). Remove everything with:\n` +
        `  memwarden down --all          # also unwire every tool\n` +
        `  memwarden down --all --data   # and delete the brain at ${dataDir}`,
    );
    return;
  }

  // Unwire every tool we know how to wire — including ones no longer
  // "detected", since a leftover config entry is exactly what we're removing.
  console.log(`[memwarden] unwiring tools:`);
  for (const t of TOOLS) {
    const u = unwireTool(t, home);
    if (u.status === "removed") {
      console.log(`    \u2713 ${t.label.padEnd(13)} MCP removed from ${u.path}`);
    } else if (u.reason !== "no config file" && u.reason !== "not wired") {
      console.log(`    \u26a0 ${t.label.padEnd(13)} skipped (${u.reason})`);
    }
  }

  // Strip memwarden's hooks from every host config (only entries whose
  // command is recognizably ours are touched — user hooks survive).
  for (const h of HOST_HOOKS) {
    for (const res of h.remove(home)) {
      if (res.status === "removed") {
        console.log(`    \u2713 ${h.label.padEnd(13)} hooks removed from ${res.path}`);
      } else if (res.status === "skipped" && res.reason) {
        console.log(`    \u26a0 ${h.label.padEnd(13)} ${res.reason}`);
      }
    }
  }

  const agents = removeAgentsMd(process.cwd());
  if (agents.removed) {
    console.log(`    \u2713 AGENTS.md      memwarden block removed (${agents.path})`);
  }
  console.log(
    `[memwarden] note: AGENTS.md blocks in OTHER projects are per-project — run\n` +
      `'memwarden down --all' from each, or delete the marked block by hand.`,
  );

  if (purgeData) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(
      `[memwarden] deleted ${dataDir} (memories, oplog, secret, embedding runtime).`,
    );
  } else {
    console.log(
      `[memwarden] your brain is untouched at ${dataDir} — delete it with\n` +
        `'memwarden down --all --data' or keep it for a future 'memwarden up'.`,
    );
  }
}

// --- `memwarden status` --------------------------------------------
//
// One honest snapshot: daemon + live stats, semantic recall, the vector
// backend ACTUALLY serving search, and per tool Detected -> Configured ->
// Live. "Configured" is read straight from the config files on disk (MCP
// entry, hook command); "Live" is the daemon's per-host heartbeat — a hook
// that actually ran and reached the daemon. Wired-but-never-live is the
// interesting failure this surfaces (tool needs a restart, or Codex hooks
// not yet trust-pinned).

interface StatsBody {
  memories?: number;
  observations?: number;
  sessions?: number;
  vectors?: number;
  vectorBackend?: string | null;
  embedding?: { provider: string; dimensions: number } | null;
  compression?: { algorithm: string; bits: number; ratio: number } | null;
  hosts?: Array<{ host?: string; lastSeen?: string }>;
}

async function status(rest: string[]): Promise<void> {
  const home = homedir();
  const dataDir = process.env.MEMWARDEN_DATA_DIR ?? join(home, ".memwarden");
  const version = (() => {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dirname(SELF), "..", "..", "package.json"), "utf8"),
      ) as { version?: string };
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  })();
  const asJson = rest.includes("--json");

  // daemon + live stats (livez is unauthenticated; stats needs the secret)
  let stats: StatsBody | null = null;
  let daemonUp = false;
  try {
    const res = await fetch(`${DAEMON_URL}/memwarden/livez`, {
      signal: AbortSignal.timeout(1500),
    });
    daemonUp = res.ok;
  } catch {
    daemonUp = false;
  }
  if (daemonUp) {
    try {
      const res = await fetch(`${DAEMON_URL}/memwarden/stats`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) stats = (await res.json()) as StatsBody;
    } catch {
      // stats stay null; daemon line still prints
    }
  }
  const lastSeen = new Map<string, string>();
  for (const h of stats?.hosts ?? []) {
    if (h.host && h.lastSeen) lastSeen.set(h.host, h.lastSeen);
  }

  // Per-tool rows: MCP state comes from the schema-exact unmerge check, the
  // hook column from each host adapter's own config file, live from the
  // daemon heartbeat. Antigravity rides the ~/.gemini family's hooks.
  interface ToolRow {
    id: string;
    label: string;
    detected: boolean;
    mcp: string;
    hooks: string;
    lastSeen: string | null;
  }
  const toolRows: ToolRow[] = TOOLS.map((t) => {
    const hookAdapter =
      hostHookById(t.id) ??
      (t.id === "antigravity" ? hostHookById("gemini") : undefined);
    const heartbeatId = hookAdapter ? hookAdapter.id : t.id;
    return {
      id: t.id,
      label: t.label,
      detected: t.detect(home),
      mcp: toolWireState(t, home),
      hooks: hookAdapter
        ? hookAdapter.wired(home)
          ? t.id === "antigravity"
            ? "via gemini"
            : "wired"
          : "—"
        : "AGENTS.md",
      lastSeen: lastSeen.get(heartbeatId) ?? null,
    };
  });
  // Gemini CLI has a hook adapter but no MCP adapter of its own (the
  // antigravity row covers the shared ~/.gemini MCP config).
  const gemini = hostHookById("gemini");
  if (gemini) {
    toolRows.push({
      id: "gemini",
      label: "Gemini CLI",
      detected: gemini.detect(home),
      mcp: "—",
      hooks: gemini.wired(home) ? "wired" : "—",
      lastSeen: lastSeen.get("gemini") ?? null,
    });
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          version,
          daemon: { up: daemonUp, url: DAEMON_URL, dataDir },
          stats,
          tools: toolRows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\nmemwarden status  (v${version})\n`);
  console.log(
    `  daemon    ${daemonUp ? "✓ running" : "✗ not running"}  ${DAEMON_URL}  brain: ${dataDir}` +
      (daemonUp && !stats ? "  (stats unavailable — secret mismatch?)" : ""),
  );
  if (stats) {
    console.log(
      `  memory    ${stats.observations ?? 0} observations, ${stats.memories ?? 0} memories, ${stats.sessions ?? 0} sessions, ${stats.vectors ?? 0} vectors`,
    );
    console.log(
      stats.embedding
        ? `  semantic  ✓ ${stats.embedding.provider} (${stats.embedding.dimensions}d)`
        : `  semantic  ✗ lexical-only (BM25) — run 'memwarden up' to install local embeddings`,
    );
    // The backend label comes from the daemon's live VectorBackend — never a
    // guess, so a native backend that failed to load shows its TS fallback.
    const backend = stats.vectorBackend ?? "typescript";
    console.log(
      stats.compression
        ? `  vectors   ${stats.compression.algorithm} ${stats.compression.bits}-bit, ${stats.compression.ratio}x smaller (${backend})`
        : `  vectors   ${backend}`,
    );
  } else {
    const { LocalEmbeddingProvider } = await import(
      "../embedding/local-embedding.js"
    );
    const avail = await LocalEmbeddingProvider.isAvailable();
    console.log(
      avail
        ? `  semantic  ✓ embedding runtime installed (daemon down — from local check)`
        : `  semantic  ✗ embedding runtime not installed — 'memwarden up' installs it`,
    );
  }

  console.log("");
  console.log(
    `  ${"tool".padEnd(13)} ${"detected".padEnd(9)} ${"mcp".padEnd(10)} ${"hooks".padEnd(12)} live`,
  );
  const procs = runningProcessNames();
  for (const r of toolRows) {
    // Without a reachable daemon there is no heartbeat to consult — "never
    // seen" would be a claim we can't back. And when the tool is wired,
    // provably running, and its hooks have never phoned home, say the
    // actionable thing outright.
    let live = "—";
    if (r.lastSeen) {
      live = `live (${relativeTime(r.lastSeen)})`;
    } else if (r.hooks !== "AGENTS.md" && daemonUp) {
      live =
        r.hooks !== "—" && toolRunState(r.id, procs) === "running"
          ? "never seen — restart it (running with the old config)"
          : "never seen";
    }
    console.log(
      `  ${r.label.padEnd(13)} ${(r.detected ? "yes" : "no").padEnd(9)} ${r.mcp.padEnd(10)} ${r.hooks.padEnd(12)} ${live}`,
    );
  }

  const agentsPath = join(process.cwd(), "AGENTS.md");
  let agentsOn = false;
  try {
    agentsOn =
      existsSync(agentsPath) &&
      readFileSync(agentsPath, "utf8").includes("<!-- memwarden:start -->");
  } catch {
    // treated as off
  }
  console.log(
    `\n  AGENTS.md ${agentsOn ? "✓ memwarden block present (this project)" : "- no memwarden block (this project)"}`,
  );
  console.log(
    `\n  wired = config on disk points at memwarden; live = a hook from that\n` +
      `  host actually reached the daemon. Wired but never live usually means\n` +
      `  the tool needs a restart (or, for Codex, /hooks trust-pinning).\n`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "up":
      return up(rest);
    case "down":
      return down(rest);
    case "status":
      return status(rest);
    case "connect":
      return connect(rest);
    case "hook":
      return hook(rest);
    case "doctor":
      return doctor(rest);
    case "audit":
      return audit(rest);
    case "exclude":
      return exclude(rest);
    case "include":
      return include(rest);
    case "forget":
      return forget(rest);
    case "compact":
      return compact(rest);
    case "dejafix":
      return dejafix(rest);
    case "export":
      return exportBrain(rest[0]);
    case "import":
      return importBrain(rest[0]);
    default:
      console.log(
        "usage:\n" +
          "  memwarden up [--all] [--agents-md] [--url URL] [--secret S]   # start daemon + wire every installed tool\n" +
          "  memwarden down [--all] [--data]                 # stop service; --all unwires every tool + hooks, --data deletes the brain\n" +
          "  memwarden status [--json]                       # daemon, semantic, vector backend, per-tool detected/mcp/hooks/live\n" +
          "  memwarden connect [claude-code|cursor|cline|windsurf] [--with-hooks] [--url URL] [--secret S]\n" +
          "  memwarden doctor [path] [--all-projects]        # audit this project (or the whole brain)\n" +
          "  memwarden audit <store> [--root repo] [--json] [--html [out.html]]  # audit a FOREIGN store (claude-mem db, CLAUDE.md, Mem0 json)\n" +
          "  memwarden exclude [path] | include [path] | exclude --list   # per-project: no capture, no injection\n" +
          "  memwarden forget <observationId> [--erase] [--json]  # delete one memory, get a tamper-evident receipt; --erase nulls its oplog content too\n" +
          "  memwarden compact [--dry-run] [--json]          # erase all forgotten memories from the oplog, migrate the chain, VACUUM\n" +
          "  memwarden dejafix lookup [--cwd dir] < err.txt  # find a verified prior fix for an error\n" +
          '  memwarden dejafix record --fix "…" [--file f] [--root-cause s] < err.txt\n' +
          "  memwarden export <file>\n" +
          "  memwarden import <file>",
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`[memwarden] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
