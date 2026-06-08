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
import { isAbsolute, resolve } from "node:path";
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
): Verdict {
  if (isUnsourced(prov)) {
    return { status: "unsourced", reason: "no file, command, or user-confirmation evidence" };
  }
  const files = prov?.files ?? [];
  const hashes = prov?.fileHashes ?? {};
  const deleted: string[] = [];
  const changed: string[] = [];
  let hashMatched = 0; // existing files whose captured hash still matches
  let unchecked = 0; // existing files we could not content-check
  for (const f of files) {
    const abs = resolveUnder(root, f);
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
