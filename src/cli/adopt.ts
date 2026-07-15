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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  /** The first error encountered, verbatim, so a failed run is diagnosable. */
  firstError?: string;
}

// A stable, per-store session id so every adopted memory lands under one
// "session" the doctor and recall can scope to — and re-adopting the same
// store dedups against it rather than piling up duplicates.
//
// The basename alone is not identity: ~/a/CLAUDE.md and ~/b/CLAUDE.md would
// share a session, silently merging two stores under one root — or, under
// different roots, tripping the session-project guard so every memory 409s.
// Fold a short digest of the resolved absolute path in to keep the id stable
// per store and distinct across stores.
export function adoptSessionId(kind: StoreKind, store: string): string {
  const abs = resolve(store);
  const stem = basename(abs).replace(/[^\w.-]/g, "-").slice(0, 48) || "store";
  const digest = createHash("sha256").update(abs).digest("hex").slice(0, 8);
  return `adopt-${kind}-${stem}-${digest}`;
}

/** True when an absolute path resolves outside `root`. Pure string logic. */
function escapesRoot(abs: string, root: string): boolean {
  const rel = relative(root, abs);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
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
  const files = anchorFiles(mem, opts.root)
    // Absolute paths pass through; relatives are resolved under the repo so
    // classifyProvenance checks them against the checkout the memory is about.
    .map((f) => (isAbsolute(f) ? f : resolve(opts.root, f)))
    // A ref mined from prose can escape the root ("../other/x.ts"). Anchoring
    // a memory to a file outside the checkout it is about can never verify
    // and only produces confusing provenance, so drop it.
    .filter((abs) => !escapesRoot(abs, opts.root));
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
  // A bare "47 failed" is useless: the causes are actionable and specific (a
  // 409 project mismatch means the wrong --root, a 401 means a bad secret).
  // Keep the first one and surface it verbatim.
  let firstError: string | undefined;
  const noteError = (msg: string): void => {
    failed++;
    if (!firstError) firstError = msg;
  };
  for (const mem of memories) {
    try {
      const res = await fetch(`${daemonUrl()}/memwarden/observe`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(observePayloadFor(mem, opts, sessionId)),
      });
      const body = (await res.json().catch(() => ({}))) as {
        deduplicated?: boolean;
        error?: string;
      };
      if (!res.ok) {
        noteError(`HTTP ${res.status}${body.error ? `: ${body.error}` : ""}`);
      } else if (body.deduplicated) deduplicated++;
      else adopted++;
    } catch (err) {
      noteError(err instanceof Error ? err.message : String(err));
    }
  }

  const result: AdoptResult = {
    store,
    kind,
    root,
    scanned: memories.length,
    adopted,
    deduplicated,
    failed,
    sessionId,
    note,
  };
  if (firstError) result.firstError = firstError;
  report(result, opts, false);
  // Nothing landed but the store had memories: that is a failed run, and the
  // shell deserves to know (scripts and CI read exit codes, not prose).
  if (failed > 0 && adopted === 0 && deduplicated === 0) process.exitCode = 1;
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
  const red = (s: string): string => paint("31", s);
  const gray = (s: string): string => paint("90", s);

  console.log(`\n${bold("memwarden adopt")} — ${r.store} (${r.kind})`);
  console.log(`${" ".repeat(18)}into brain, anchored to ${r.root}\n`);
  if (dryRun) {
    console.log(
      `  ${r.scanned} memories would be adopted (dry run — nothing written)`,
    );
  } else {
    console.log(
      green(`  ${r.adopted} adopted`) +
        ` · ${r.deduplicated} already present · ${r.failed} failed` +
        `  (of ${r.scanned} scanned)`,
    );
    console.log(gray(`  session: ${r.sessionId}`));
    if (r.firstError) {
      console.log(red(`\n  first error: ${r.firstError}`));
      console.log(
        gray("  (a 409 usually means --root points at the wrong project)"),
      );
    }
  }
  console.log(gray(`\n  note: ${r.note}\n`));
}
