//
// Verified Recall: classify a memory's trustworthiness against the live repo.
// This is what makes "verified" literal — not just "does the file exist" but
// "is the file still what it was when we learned this".
//
//   verified           a referenced file exists and still matches its
//                      capture-time content hash (code-backed and current)
//   sourced_unverified sourced (command/confirmation, or files present but
//                      none hashable), so allowed, but NOT content-verified
//   stale              a referenced file was deleted, or its content changed
//   unsourced          no evidence at all (no files, no command, not confirmed)
//
// All checks read the repo, so this runs in the daemon (same machine). Hashing
// is best-effort: files missing at capture, non-files, and files over the size
// cap are not hashed, so such a memory verifies by existence only and reports
// sourced_unverified rather than verified.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Provenance } from "./types.js";
import { isUnsourced } from "./provenance.js";

// Don't hash enormous files; treat them as unhashed (existence-only).
const MAX_HASH_BYTES = 2_000_000;

function hashFile(abs: string): string | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_HASH_BYTES) return null;
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

function resolveUnder(root: string, file: string): string {
  return isAbsolute(file) ? file : resolve(root, file);
}

/**
 * Hash the referenced files under `root` at capture time (best-effort). Files
 * that don't exist or are too large are simply omitted; the result is stored
 * in provenance so later recall can detect content drift.
 */
export function hashFiles(
  files: string[] | undefined,
  root: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!files) return out;
  for (const f of files) {
    const h = hashFile(resolveUnder(root, f));
    if (h) out[f] = h;
  }
  return out;
}

export type VerifyStatus =
  | "verified"
  | "sourced_unverified"
  | "stale"
  | "unsourced";
export interface Verdict {
  status: VerifyStatus;
  reason: string;
}

export function classifyProvenance(
  prov: Provenance | undefined,
  root: string,
  opts?: {
    /**
     * Verify relative files against `root` (the CALLER's checkout) instead
     * of the capture directory. Callers set this when they have proven the
     * two directories are the same project (matching stable projectKey —
     * e.g. two git worktrees of one repo). Without it, recall from worktree
     * B would "verify" a memory against worktree A's files: a checkout that
     * has since diverged, or was deleted (false stale). With it, the verdict
     * answers the question Verified Recall actually asks: is this memory
     * still true HERE, where the agent is working.
     */
    verifyAgainstRoot?: boolean;
  },
): Verdict {
  if (isUnsourced(prov)) {
    return { status: "unsourced", reason: "no file, command, or user-confirmation evidence" };
  }
  const files = prov?.files ?? [];
  const hashes = prov?.fileHashes ?? {};
  // Resolve RELATIVE files against the cwd the memory was captured in, not
  // the caller's cwd. provenance.files are relative to provenance.cwd; using
  // `root` instead would verify a memory against a DIFFERENT project's file
  // of the same relative name (e.g. two repos both with src/auth.ts) and
  // produce a false `verified` (hashes happen to match) or false `stale`
  // (the other repo lacks the file). Absolute files are unaffected. Fall
  // back to `root` only when the memory recorded no cwd — or when the caller
  // proved same-project identity and asked to verify against its checkout.
  const base =
    !opts?.verifyAgainstRoot && prov?.cwd && isAbsolute(prov.cwd)
      ? prov.cwd
      : root;
  const captureCwd = prov?.cwd && isAbsolute(prov.cwd) ? prov.cwd : undefined;
  const deleted: string[] = [];
  const changed: string[] = [];
  let hashMatched = 0; // existing files whose captured hash still matches
  let unchecked = 0; // existing files we could not content-check
  for (const f of files) {
    let abs = resolveUnder(base, f);
    // ABSOLUTE files recorded inside the capture checkout must follow the
    // same re-rooting as relative ones when the caller proved same-project
    // identity — otherwise recall from worktree B silently verifies against
    // worktree A's (possibly diverged, possibly deleted) copy and reports a
    // false "verified". Absolute files OUTSIDE the capture cwd keep their
    // own identity: re-rooting those would point a cross-project reference
    // at the wrong repo.
    if (opts?.verifyAgainstRoot && captureCwd && isAbsolute(f)) {
      const rel = relative(captureCwd, f);
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        abs = resolve(root, rel);
      }
    }
    if (!existsSync(abs)) {
      deleted.push(f);
      continue;
    }
    const recorded = hashes[f];
    if (!recorded) {
      unchecked++; // no hash captured (e.g. too large at capture)
      continue;
    }
    const current = hashFile(abs);
    if (current && current !== recorded) changed.push(f);
    else if (current && current === recorded) hashMatched++;
    else unchecked++; // can't hash now (e.g. grew past the cap) -> unverified
  }
  if (deleted.length > 0 || changed.length > 0) {
    const parts: string[] = [];
    if (deleted.length > 0) parts.push(`deleted: ${deleted.slice(0, 2).join(", ")}`);
    if (changed.length > 0) parts.push(`changed: ${changed.slice(0, 2).join(", ")}`);
    return { status: "stale", reason: `references files that no longer match (${parts.join("; ")})` };
  }
  // Mixed-trust content carries material its file evidence does not cover —
  // a handoff digest embedding an unsourced prompt, or a capture whose file
  // list was capped. One unchanged tracked file must not add up to
  // "verified" for the whole memory. Drift above still proves it stale;
  // matching hashes only ever earn "sourced".
  if (prov?.mixedTrust === true) {
    return {
      status: "sourced_unverified",
      reason:
        "the memory's evidence is incomplete (mixed or capped at capture); file hashes cannot vouch for all of it",
    };
  }
  // Verified only when EVERY existing referenced file was content-checked.
  // A single unchecked file (unhashed, or too large) leaves the memory
  // sourced-but-not-verified, so one matching hash can't vouch for the rest.
  if (hashMatched > 0 && unchecked === 0) {
    return { status: "verified", reason: "all referenced files exist and match their captured hashes" };
  }
  return {
    status: "sourced_unverified",
    reason:
      hashMatched > 0
        ? "some referenced files verified, but others could not be content-checked"
        : files.length > 0
          ? "referenced files exist but were not hashed at capture (existence only)"
          : "sourced by command or user, no file evidence to verify against",
  };
}
