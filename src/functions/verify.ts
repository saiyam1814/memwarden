//
// Verified Recall: classify a memory's trustworthiness against the live repo.
// This is what makes "verified" literal — not just "does the file exist" but
// "is the file still what it was when we learned this".
//
//   verified   sourced, and every referenced file still exists and (when a
//              capture-time hash was recorded) still matches it
//   stale      a referenced file was deleted, or its content changed
//   unsourced  no evidence at all (no files, no command, not user-confirmed)
//
// All checks read the repo, so this runs in the daemon (same machine).

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

export type VerifyStatus = "verified" | "stale" | "unsourced";
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
  for (const f of files) {
    const abs = resolveUnder(root, f);
    if (!existsSync(abs)) {
      deleted.push(f);
      continue;
    }
    const recorded = hashes[f];
    if (recorded) {
      const current = hashFile(abs);
      if (current && current !== recorded) changed.push(f);
    }
  }
  if (deleted.length > 0 || changed.length > 0) {
    const parts: string[] = [];
    if (deleted.length > 0) parts.push(`deleted: ${deleted.slice(0, 2).join(", ")}`);
    if (changed.length > 0) parts.push(`changed: ${changed.slice(0, 2).join(", ")}`);
    return { status: "stale", reason: `references files that no longer match (${parts.join("; ")})` };
  }
  return { status: "verified", reason: "sourced and current" };
}
