//
// mem::adopt — seed an EXISTING foreign memory store (a claude-mem/any SQLite
// db, a CLAUDE.md/AGENTS.md/rules markdown pile, or a Mem0-style JSON export)
// into the memwarden brain so its memories flow across your agents like any
// captured memory.
//
// The honesty boundary matters here. Foreign stores carry no capture-time
// content hashes, so an adopted memory can never be `verified` by construction
// — hashing its referenced files against the CURRENT repo would forge a
// verdict about a state we never saw. So adopt seeds each memory with the
// `adopted` marker: the capture path records the referenced files WITHOUT
// hashing them, and Verified Recall caps the result at `sourced_unverified`
// (or `stale`, if a referenced file is already gone). Adopting old memory
// gives you labeled, drift-aware memory — not verified memory. `memwarden
// audit <store>` is the read-only preview of what you are about to adopt.
//
import { ensureDaemon } from "../daemon/ensure.js";
import {
  extractFileRefs,
  loadStore,
  type ForeignMemory,
  type StoreKind,
} from "../functions/audit.js";
import { getSecret } from "../functions/config.js";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

// Resolved per call (not at module load) so the target follows MEMWARDEN_URL
// even when it is set after import — the same late-binding getSecret() relies on.
function daemonUrl(): string {
  return process.env.MEMWARDEN_URL ?? "http://localhost:3111";
}

interface AdoptOptions {
  store: string;
  root: string;
  project: string;
  agent: string;
  dryRun: boolean;
  json: boolean;
}

interface AdoptResult {
  store: string;
  kind: StoreKind;
  root: string;
  scanned: number;
  adopted: number;
  deduplicated: number;
  failed: number;
  sessionId: string;
  note: string;
}

// A stable, per-store session id so every adopted memory lands under one
// "session" the doctor and recall can scope to — and re-adopting the same
// store dedups against it rather than piling up duplicates.
function adoptSessionId(kind: StoreKind, store: string): string {
  const stem = basename(store).replace(/[^\w.-]/g, "-").slice(0, 48) || "store";
  return `adopt-${kind}-${stem}`;
}

// The files a memory can be anchored to, mirroring `memwarden audit` exactly
// (audit.ts::auditStore): the store's explicit file list, plus slashed paths
// mined from the memory text, plus bare filenames that actually resolve under
// the repo root. This is what lets a markdown/Mem0 memory — which carries no
// file column — still anchor to the code it talks about.
function anchorFiles(mem: ForeignMemory, root: string): string[] {
  const fromText = extractFileRefs(mem.text);
  const files = new Set<string>([...mem.files, ...fromText.pathRefs]);
  for (const bare of fromText.bareRefs) {
    if (existsSync(join(root, bare))) files.add(bare);
  }
  return [...files];
}

// Build the /observe payload for one foreign memory. Two things ride together:
// the prompt text (title + body) drives a good synthetic compression — title,
// narrative, searchable — while tool_input carries the anchored files so
// provenance can flag drift. `adopted: true` keeps those files un-hashed.
function observePayloadFor(
  mem: ForeignMemory,
  opts: AdoptOptions,
  sessionId: string,
): Record<string, unknown> {
  const promptBody = mem.text.trim()
    ? `${mem.title}\n\n${mem.text}`
    : mem.title;
  const files = anchorFiles(mem, opts.root).map((f) =>
    // Absolute paths pass through; relatives are resolved under the repo so
    // classifyProvenance checks them against the checkout the memory is about.
    isAbsolute(f) ? f : join(opts.root, f),
  );
  return {
    hookType: "user_prompt",
    sessionId,
    project: opts.project,
    cwd: opts.root,
    timestamp: mem.timestamp ?? new Date().toISOString(),
    agent: opts.agent,
    adopted: true,
    data: {
      prompt: promptBody,
      // FILE_KEYS ("file_path") lets extractProvenance collect these; one
      // object per file avoids duplicate keys and keeps the shape explicit.
      tool_input: files.map((f) => ({ file_path: f })),
      origin: mem.origin,
    },
  };
}

// Value flags each consume the following arg; record those indices so a flag's
// value (e.g. the path after --root) is never mistaken for the positional store.
function parseFlagValue(
  rest: string[],
  flag: string,
  consumed: Set<number>,
): string | undefined {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const next = rest[i + 1];
  if (!next || next.startsWith("--")) return undefined;
  consumed.add(i + 1);
  return next;
}

export async function adopt(rest: string[]): Promise<void> {
  const consumed = new Set<number>();
  const root = resolve(parseFlagValue(rest, "--root", consumed) ?? process.cwd());
  const project = parseFlagValue(rest, "--project", consumed) ?? root;
  const agent = parseFlagValue(rest, "--agent", consumed) ?? "adopt";
  const store = rest.find(
    (a, i) => !a.startsWith("--") && !consumed.has(i),
  );
  if (!store) {
    throw new Error(
      "usage: memwarden adopt <store.db|store.json|CLAUDE.md|dir> [--root repo] [--project path] [--agent name] [--dry-run] [--json]",
    );
  }
  const opts: AdoptOptions = {
    store,
    root,
    // Default the project to the root, exactly as the capture path does
    // (cli/hook.ts sends `project: cwd`), so `doctor .` in that repo sees it.
    project,
    agent,
    dryRun: rest.includes("--dry-run"),
    json: rest.includes("--json"),
  };

  const { kind, memories } = await loadStore(store);
  const sessionId = adoptSessionId(kind, store);
  const note =
    "adopted memories are labeled sourced_unverified (no capture-time hashes); " +
    "run `memwarden doctor` to see how they classify against your repo";

  if (opts.dryRun) {
    const result: AdoptResult = {
      store,
      kind,
      root,
      scanned: memories.length,
      adopted: 0,
      deduplicated: 0,
      failed: 0,
      sessionId,
      note,
    };
    report(result, opts, true);
    return;
  }

  // Bring the daemon up if it isn't already — adopt is a legitimate first
  // touch (a user auditing then adopting before `memwarden up`).
  await ensureDaemon(daemonUrl());

  let adopted = 0;
  let deduplicated = 0;
  let failed = 0;
  for (const mem of memories) {
    try {
      const res = await fetch(`${daemonUrl()}/memwarden/observe`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(observePayloadFor(mem, opts, sessionId)),
      });
      const body = (await res.json().catch(() => ({}))) as {
        deduplicated?: boolean;
      };
      if (!res.ok) failed++;
      else if (body.deduplicated) deduplicated++;
      else adopted++;
    } catch {
      failed++;
    }
  }

  report({ store, kind, root, scanned: memories.length, adopted, deduplicated, failed, sessionId, note }, opts, false);
}

// Auth mirrors the other CLI commands: getSecret() resolves the env var first,
// then the persisted <dataDir>/secret file, so adopt authenticates to a
// secured daemon from a plain shell.
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const secret = getSecret();
  if (secret) h["authorization"] = `Bearer ${secret}`;
  return h;
}

function report(r: AdoptResult, opts: AdoptOptions, dryRun: boolean): void {
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const tty = process.stdout.isTTY === true;
  const paint = (code: string, s: string): string =>
    tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  const bold = (s: string): string => paint("1", s);
  const green = (s: string): string => paint("32", s);
  const gray = (s: string): string => paint("90", s);

  console.log(`\n${bold("memwarden adopt")} — ${r.store} (${r.kind})`);
  console.log(`${" ".repeat(18)}into brain, anchored to ${r.root}\n`);
  if (dryRun) {
    console.log(`  ${r.scanned} memories would be adopted (dry run — nothing written)`);
  } else {
    console.log(green(`  ${r.adopted} adopted`) + ` · ${r.deduplicated} already present · ${r.failed} failed  (of ${r.scanned} scanned)`);
    console.log(gray(`  session: ${r.sessionId}`));
  }
  console.log(gray(`\n  note: ${r.note}\n`));
}
