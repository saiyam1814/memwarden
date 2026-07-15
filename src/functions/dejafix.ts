//
// Déjà Fix — the cross-agent "don't repeat a mistake I already fixed" engine.
//
// The daemon sees EVERY agent's sessions, so it can do what no per-tool memory
// can: when any agent (Claude Code, Codex, Cursor, …) resolves an error, it
// captures {error signature -> root cause + fix} with provenance file-hashes.
// Later, when ANY agent hits a matching error signature, the verified fix is
// surfaced — but ONLY if the fix's referenced files still hash-match. A stale
// fix is never surfaced (Verified Recall, reusing classifyProvenance).
//
// Storage: one dedicated KV scope (DEJAFIX_SCOPE), keyed by error signature.
// Each key holds an append-only list of FixMemory records (newest appended
// last). This is the exact StateKV scope/serialization pattern used by
// access-tracker.ts (KV.accessLog keyed by id) — no new storage mechanism.
//
// Project scoping: a FixMemory records its capture cwd; lookup canonicalizes
// both the stored cwd and the caller cwd (paths.ts) so a fix learned in one
// repo is never surfaced in another.

import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { Provenance } from "./types.js";
import { classifyProvenance, hashFiles } from "./verify.js";
import { canonicalizePath } from "./paths.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { generateId } from "../state/schema.js";
import { logger } from "./logger.js";

// Dedicated KV scope, in the `mem:` namespace like every other scope in
// schema.ts. Kept local to this module so the feature is self-contained; the
// underlying mechanism (StateKV scope + key) is identical to access-tracker.
export const DEJAFIX_SCOPE = "mem:dejafix";

// Cap the number of records retained per signature so a hot, repeatedly-fixed
// error can't grow a key without bound. Newest are kept.
const MAX_FIXES_PER_SIGNATURE = 25;

/** A captured {error signature -> root cause + fix} record. */
export interface FixMemory {
  /** Stable signature of the error this fix resolves. */
  signature: string;
  /** Id of the observation/record this fix was captured from. */
  observationId: string;
  /** Optional one-line root cause. */
  rootCause?: string;
  /** Short narrative of the fix that resolved the error. */
  fix: string;
  /** Evidence trail (files + fileHashes) reused by Verified Recall. */
  provenance: Provenance;
  /** Which agent recorded it (claude, codex, cursor, …). */
  tool?: string;
  /** Session it was recorded in. */
  sessionId?: string;
  /** Capture-time working directory (project scope). */
  cwd: string;
  /** ISO timestamp the fix was recorded. */
  timestamp: string;
}

/** A FixMemory surfaced by lookup, annotated with a freshness badge. */
export interface VerifiedFix {
  signature: string;
  observationId: string;
  rootCause?: string;
  fix: string;
  tool?: string;
  sessionId?: string;
  cwd: string;
  timestamp: string;
  /** "verified current" when all referenced files still hash-match; else
   *  "sourced, unverified". Stale fixes are never returned at all. */
  badge: "verified current" | "sourced, unverified";
  /** The underlying classifier status (verified | sourced_unverified). */
  status: "verified" | "sourced_unverified";
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

// Volatile-token scrubbers, applied to candidate stable text. Order matters:
// timestamps and UUIDs/hex before bare numbers, so the broad number rule can't
// shred them first.
function scrubVolatile(s: string): string {
  return (
    s
      // ISO-ish timestamps: 2026-06-10T12:34:56.789Z / 2026-06-10 12:34:56
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<TS>")
      // UUIDs
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "<UUID>",
      )
      // Hex addresses / pointers: 0x1a2b3c
      .replace(/0x[0-9a-f]+/gi, "<HEX>")
      // Long bare hex blobs (>=8 hex chars), e.g. content hashes
      .replace(/\b[0-9a-f]{8,}\b/gi, "<HEX>")
      // Durations: 12ms, 1.5s, 200µs, 3m
      .replace(/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s|m|h)\b/gi, "<DUR>")
      // Ports on a host:port — keep host, drop port
      .replace(/(:)\d{2,5}\b/g, "$1<PORT>")
      // Any remaining bare numbers (line/col, counts, sizes)
      .replace(/\b\d+(?:\.\d+)?\b/g, "<N>")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Replace absolute/relative path tokens with their basename so a stack frame's
// location is stable across machines and checkouts. Runs BEFORE number scrub so
// the path's own line/col digits get normalized as part of the path token.
function basenamePaths(s: string): string {
  // A path-ish token: optional drive, slashes, ending in a dotted file. Capture
  // the trailing file and any :line:col suffix.
  return s.replace(
    /(?:[A-Za-z]:)?(?:\/|\\)?(?:[\w.\-]+(?:\/|\\))+([\w.\-]+\.\w{1,8})(?::\d+(?::\d+)?)?/g,
    (_m, file: string) => file,
  );
}

const STACK_FRAME_RE = /^\s*at\s+/;

// Keep only the error message itself, dropping any trailing prose on the same
// line (e.g. "TypeError: x is undefined. Fixed by adding a guard."). Cutting at
// the first sentence terminator means an error captured WITH its resolution
// narrative produces the same signature as the bare error looked up later. The
// "Error: ENOENT:" double-colon shape is preserved (we only cut on . ! ?).
function firstSentence(msg: string): string {
  // First drop a trailing INLINE stack frame ("… at src/x.ts:9:14" or
  // "… at Object.foo (src/x.ts:9:14)") so a message captured with an inline
  // location matches the same message looked up without one. Only strip when
  // the tail carries a :line-number, so plain prose like "failed at startup"
  // or "retried at line 5" (no colon+digits) is left intact.
  const deframed = msg.replace(/\s+at\s+\S.*$/, (m) => (/:\d+/.test(m) ? "" : m));
  const cut = deframed.search(/[.!?](?:\s|$)/);
  return cut > 0 ? deframed.slice(0, cut) : deframed;
}

/**
 * Extract a STABLE signature from an error message, stack trace, or failing
 * test output. Returns null when nothing recognizable as an error is present.
 *
 * The signature normalizes away volatile parts (absolute paths -> basename,
 * line/column numbers, hex addresses, timestamps, UUIDs, ports, durations) and
 * keeps the stable core: the error/exception class, the failing test name, and
 * the key message tokens. Deterministic: same logical error -> same signature.
 */
export function errorSignature(text: string): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/);

  // 1) TypeScript compiler error: "file.ts(12,5): error TS2304: Cannot find …"
  //    or "file.ts:12:5 - error TS2304: …"
  for (const raw of lines) {
    const m = raw.match(/error\s+(TS\d{3,5})\s*:\s*(.+)$/i);
    if (m && m[1] && m[2]) {
      const code = m[1].toUpperCase();
      const msg = scrubVolatile(basenamePaths(m[2]));
      return sig(`ts ${code}: ${msg}`);
    }
  }

  // 2) Vitest / Jest failing-test line. Vitest: " FAIL  test/x.test.ts > suite
  //    > name". Jest: "  ✕ suite › name (12 ms)". Also "● suite › name".
  for (const raw of lines) {
    const vitest = raw.match(/\bFAIL\b\s+(.+?)\s*>\s*(.+)$/);
    if (vitest && vitest[2]) {
      const name = scrubVolatile(basenamePaths(vitest[2]));
      return sig(`test fail: ${name}`);
    }
    const jest = raw.match(/^[\s│]*(?:[✕✗×]|●)\s+(.+)$/);
    if (jest && jest[1]) {
      const name = scrubVolatile(basenamePaths(jest[1]));
      if (name) return sig(`test fail: ${name}`);
    }
  }

  // 3) Node / generic exception line: "TypeError: x is not a function",
  //    "Error: ENOENT: no such file …", "ReferenceError: y is not defined".
  //    Prefer the first stack-trace header over a later "at" frame.
  for (const raw of lines) {
    if (STACK_FRAME_RE.test(raw)) continue;
    const m = raw.match(/\b([A-Z][A-Za-z]*(?:Error|Exception))\b\s*:\s*(.+)$/);
    if (m && m[1] && m[2]) {
      const cls = m[1];
      const msg = scrubVolatile(basenamePaths(firstSentence(m[2])));
      return sig(`${cls}: ${msg}`);
    }
  }

  // 4) Bare "<Class>Error" / "<Class>Exception" with no colon message.
  for (const raw of lines) {
    if (STACK_FRAME_RE.test(raw)) continue;
    const m = raw.match(/\b([A-Z][A-Za-z]*(?:Error|Exception))\b/);
    if (m && m[1]) return sig(m[1]);
  }

  // 5) Generic "Error: …" / "error: …" anywhere, last resort.
  for (const raw of lines) {
    const m = raw.match(/\berror\s*:\s*(.+)$/i);
    if (m && m[1]) {
      const msg = scrubVolatile(basenamePaths(firstSentence(m[1])));
      if (msg) return sig(`error: ${msg}`);
    }
  }

  return null;
}

// Final normalization: lowercase + truncate so casing/length never split a
// signature. Truncation keeps the head (error class + first message tokens).
function sig(core: string): string {
  return core.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

/** True when `text` contains both an error AND resolution language — the
 *  shape that observe.ts treats as a recorded fix worth signature-tagging. */
export function looksLikeResolvedFix(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  if (errorSignature(text) === null) return false;
  return /\b(fix(?:ed|es)?|resolv(?:e|ed|es)|solv(?:e|ed|es)|root cause|the issue was|turned out|caused by|patch(?:ed)?)\b/i.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function keyFor(signature: string): string {
  // The signature is already normalized + capped; use it directly as the KV
  // key. Spaces and ":" are fine in StateKV keys (it's an opaque string key).
  return signature;
}

function lockKeyFor(signature: string): string {
  return `dejafix:${signature}`;
}

/** Parse a stored value into a FixMemory[] (tolerant of legacy/garbage). */
function asFixList(raw: unknown): FixMemory[] {
  if (!Array.isArray(raw)) return [];
  const out: FixMemory[] = [];
  for (const r of raw) {
    if (
      r &&
      typeof r === "object" &&
      typeof (r as FixMemory).signature === "string" &&
      typeof (r as FixMemory).fix === "string" &&
      typeof (r as FixMemory).cwd === "string"
    ) {
      out.push(r as FixMemory);
    }
  }
  return out;
}

export interface RecordFixInput {
  /** Error text (or its signature) the fix resolves. */
  errorText?: string;
  /** Precomputed signature (overrides errorText if both given). */
  signature?: string;
  observationId?: string;
  rootCause?: string;
  fix: string;
  /** Files the fix touched/relied on; hashed under cwd for drift checks. */
  files?: string[];
  /** A fully-formed provenance (overrides files-based one if given). */
  provenance?: Provenance;
  tool?: string;
  sessionId?: string;
  cwd: string;
  timestamp?: string;
}

/**
 * Store a FixMemory under its signature. Returns the stored record, or null
 * when no signature can be derived (nothing to key on). Hashes the referenced
 * files at capture time so later recall can detect drift — exactly like
 * observe.ts does for synthetic observations.
 */
export async function recordFix(
  kv: StateKV,
  input: RecordFixInput,
): Promise<FixMemory | null> {
  const signature =
    input.signature ??
    (input.errorText ? errorSignature(input.errorText) : null);
  if (!signature) return null;
  if (!input.fix || !input.fix.trim()) return null;
  if (!input.cwd || !input.cwd.trim()) return null;

  // Build provenance: prefer an explicit one, else derive from files.
  let provenance: Provenance;
  if (input.provenance) {
    // The CALLER already decided what this memory's evidence is — never
    // re-hash it here. observe.ts hashes at capture for a normal capture (so
    // the hashes are already on the provenance it hands us), and deliberately
    // does NOT for an adopted memory seeded from a foreign store, which had no
    // capture-time hashes to begin with. Hashing here would invent evidence
    // for a state we never observed and surface an adopted memory to the next
    // agent as a "verified current" fix.
    provenance = { ...input.provenance };
  } else {
    // An explicitly recorded fix is itself the evidence — the agent/user
    // asserted "this resolved the error". That makes it sourced (userConfirmed)
    // even with no referenced files, so it surfaces as "sourced, unverified"
    // rather than being dropped as unsourced. File-backed fixes additionally
    // verify by content hash: hash them under cwd now so content drift is
    // detectable at recall.
    provenance = { userConfirmed: true, cwd: input.cwd };
    if (input.files && input.files.length > 0) provenance.files = input.files;
    const files = provenance.files;
    if (files && files.length > 0) {
      const hashes = hashFiles(files, input.cwd);
      if (Object.keys(hashes).length > 0) provenance.fileHashes = hashes;
    }
  }
  if (!provenance.cwd) provenance.cwd = input.cwd;

  const record: FixMemory = {
    signature,
    observationId: input.observationId ?? generateId("fix"),
    fix: input.fix.trim(),
    provenance,
    cwd: input.cwd,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  if (input.rootCause && input.rootCause.trim())
    record.rootCause = input.rootCause.trim();
  if (input.tool) record.tool = input.tool;
  if (input.sessionId) record.sessionId = input.sessionId;

  await withKeyedLock(lockKeyFor(signature), async () => {
    const existing = asFixList(await kv.get(DEJAFIX_SCOPE, keyFor(signature)));
    existing.push(record);
    const trimmed = existing.slice(-MAX_FIXES_PER_SIGNATURE);
    await kv.set(DEJAFIX_SCOPE, keyFor(signature), trimmed);
  });

  return record;
}

/**
 * Look up verified fixes for an error. Computes the signature, fetches the
 * candidate FixMemories scoped to the caller's project (canonicalized cwd),
 * runs each through classifyProvenance, and returns ONLY verified /
 * sourced_unverified ones — never stale, never if referenced files vanished.
 * Each is annotated with a freshness badge. Newest first.
 */
export async function lookupFix(
  kv: StateKV,
  errorText: string,
  cwd: string,
): Promise<VerifiedFix[]> {
  const signature = errorSignature(errorText);
  if (!signature) return [];
  if (!cwd || !cwd.trim()) return [];

  const candidates = asFixList(await kv.get(DEJAFIX_SCOPE, keyFor(signature)));
  if (candidates.length === 0) return [];

  const wantProject = canonicalizePath(cwd);
  const out: VerifiedFix[] = [];
  for (const c of candidates) {
    // Project firewall: a fix learned in another repo never surfaces here.
    if (canonicalizePath(c.cwd) !== wantProject) continue;

    // Verified Recall: classify against the LIVE repo at `cwd`. Stale (deleted
    // or content-changed referenced file) and unsourced fixes are dropped.
    const verdict = classifyProvenance(c.provenance, cwd);
    if (verdict.status === "stale" || verdict.status === "unsourced") continue;

    const fix: VerifiedFix = {
      signature: c.signature,
      observationId: c.observationId,
      fix: c.fix,
      cwd: c.cwd,
      timestamp: c.timestamp,
      status: verdict.status,
      badge:
        verdict.status === "verified" ? "verified current" : "sourced, unverified",
    };
    if (c.rootCause !== undefined) fix.rootCause = c.rootCause;
    if (c.tool !== undefined) fix.tool = c.tool;
    if (c.sessionId !== undefined) fix.sessionId = c.sessionId;
    out.push(fix);
  }

  // Newest first.
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Kernel function registration
// ---------------------------------------------------------------------------

/**
 * Register the two Déjà Fix kernel functions:
 *   mem::dejafix_record  — store a fix (input: errorText|signature, fix, …)
 *   mem::dejafix_lookup  — surface verified fixes for an error (input:
 *                          errorText, cwd)
 *
 * Both are thin, dependency-free, and go through the same StateKV chokepoint
 * every other mem:: function uses, so they share the one persistence layer.
 */
export function registerDejaFixFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::dejafix_record",
    async (
      data: RecordFixInput,
    ): Promise<{ recorded: boolean; signature?: string; observationId?: string }> => {
      try {
        const rec = await recordFix(kv, data);
        if (!rec) return { recorded: false };
        return {
          recorded: true,
          signature: rec.signature,
          observationId: rec.observationId,
        };
      } catch (err) {
        logger.warn("mem::dejafix_record failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { recorded: false };
      }
    },
  );

  sdk.registerFunction(
    "mem::dejafix_lookup",
    async (data: {
      errorText?: string;
      error_text?: string;
      cwd?: string;
    }): Promise<{ signature: string | null; fixes: VerifiedFix[] }> => {
      const errorText =
        typeof data?.errorText === "string"
          ? data.errorText
          : typeof data?.error_text === "string"
            ? data.error_text
            : "";
      const cwd = typeof data?.cwd === "string" ? data.cwd : "";
      const signature = errorText ? errorSignature(errorText) : null;
      if (!signature || !cwd) return { signature, fixes: [] };
      try {
        const fixes = await lookupFix(kv, errorText, cwd);
        return { signature, fixes };
      } catch (err) {
        logger.warn("mem::dejafix_lookup failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { signature, fixes: [] };
      }
    },
  );
}
