//
// Verified Recall: classify capture evidence against live source. Whole-file
// SHA-256 remains the conservative fallback. A fine-grained anchor set may
// override whole-file drift only when its validated capture metadata proves
// complete claim/source coverage and every live anchor is re-hashed.
//

import { isAbsolute, relative, sep } from "node:path";
import type { Provenance } from "./types.js";
import { isUnsourced } from "./provenance.js";
import {
  isActionableFineGrainedEvidence,
  isPortableAnchorPath,
  verifyFineGrainedEvidence,
  type FineGrainedVerification,
} from "./anchors.js";
import {
  MAX_SOURCE_HASH_BYTES,
  normalizedTextHash,
  readBoundedFile,
  readBoundedFileUnderRoot,
  sha256,
  SHA256_RE,
  type BoundedReadResult,
} from "./source-content.js";

const MAX_VERIFY_FILES = 256;

function relativeInside(root: string, file: string): string | null {
  if (!isAbsolute(root) || !isAbsolute(file)) return null;
  const rel = relative(root, file);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return null;
  }
  return rel;
}

/** Relative evidence is always constrained to its checkout. Absolute evidence
 * under that checkout receives the same symlink-escape protection; intentionally
 * external absolute evidence keeps its historical identity for compatibility. */
function readEvidenceFile(
  root: string,
  file: string,
  maxBytes = MAX_SOURCE_HASH_BYTES,
): BoundedReadResult {
  if (typeof file !== "string" || !file || file.includes("\0")) {
    return { ok: false, reason: "unsafe" };
  }
  if (!isAbsolute(file)) return readBoundedFileUnderRoot(root, file, maxBytes);
  const rel = relativeInside(root, file);
  return rel
    ? readBoundedFileUnderRoot(root, rel, maxBytes)
    : readBoundedFile(file, maxBytes);
}

/** Hash referenced files under `root` at capture time. Unsafe, missing,
 * non-file, or oversized entries are omitted, so omission can never mint a
 * verified verdict. */
export function hashFiles(
  files: string[] | undefined,
  root: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(files)) return out;
  for (const file of files.slice(0, MAX_VERIFY_FILES)) {
    const read = readEvidenceFile(root, file);
    if (read.ok) out[file] = sha256(read.bytes);
  }
  return out;
}

/** Formatting-normalized companions for captures that are valid UTF-8. */
export function hashFilesNormalized(
  files: string[] | undefined,
  root: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(files)) return out;
  for (const file of files.slice(0, MAX_VERIFY_FILES)) {
    const read = readEvidenceFile(root, file);
    if (!read.ok) continue;
    const normalized = normalizedTextHash(read.bytes);
    if (normalized) out[file] = normalized;
  }
  return out;
}

export type VerifyStatus =
  | "verified"
  | "sourced_unverified"
  | "stale"
  | "unsourced";

/** Capture evidence quality, independent of what the live checkout looks like. */
export type EvidenceTrust = "verified" | "sourced" | "unsourced";
/** The effective live relationship after complete fine-grained fallback. */
export type LiveSourceStatus =
  | "matched"
  | "cosmetic_drift"
  | "drifted"
  | "missing"
  | "unknown";

export interface Verdict {
  /** Compatibility four-state verdict retained for existing clients. */
  status: VerifyStatus;
  /** Compatibility summary reason retained for existing clients. */
  reason: string;
  evidenceTrust: EvidenceTrust;
  evidenceReason: string;
  sourceStatus: LiveSourceStatus;
  sourceReason: string;
  /** Additive diagnostics. This is recomputed and is never persisted. */
  fineGrained?: FineGrainedVerification;
}

function declaredAnchorPaths(prov: Provenance): Set<string> | null {
  const files = prov.files;
  const captureCwd = prov.cwd;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_VERIFY_FILES) {
    return null;
  }
  const paths = new Set<string>();
  for (const file of files) {
    if (typeof file !== "string" || !file) return null;
    let candidate = file;
    if (isAbsolute(file)) {
      if (!captureCwd || !isAbsolute(captureCwd)) return null;
      const rel = relativeInside(captureCwd, file);
      if (!rel) return null;
      candidate = rel;
    }
    const portable = candidate.split(sep).join("/");
    if (!isPortableAnchorPath(portable)) return null;
    paths.add(portable);
  }
  return paths;
}

/** Runtime cross-check of the capture's coverage assertion. A caller cannot
 * label one anchored file "complete" while declaring another source file. */
function anchorsCoverDeclaredFiles(prov: Provenance): boolean {
  if (
    prov.mixedTrust === true ||
    !isActionableFineGrainedEvidence(prov.anchors)
  ) {
    return false;
  }
  const declared = declaredAnchorPaths(prov);
  if (!declared) return false;
  const anchored = new Set(prov.anchors.anchors.map((anchor) => anchor.path));
  return (
    anchored.size === declared.size &&
    [...declared].every((path) => anchored.has(path))
  );
}

/** Classify only capture-time evidence. This does not read the checkout. */
export function evidenceTrustOf(prov: Provenance | undefined): EvidenceTrust {
  if (isUnsourced(prov)) return "unsourced";
  const files = prov?.files ?? [];
  const hashes = prov?.fileHashes ?? {};
  const wholeFileComplete =
    files.length > 0 &&
    files.length <= MAX_VERIFY_FILES &&
    files.every(
      (file) =>
        typeof file === "string" &&
        typeof hashes[file] === "string" &&
        SHA256_RE.test(hashes[file]!),
    );
  return prov?.mixedTrust !== true &&
    (wholeFileComplete || (prov ? anchorsCoverDeclaredFiles(prov) : false))
    ? "verified"
    : "sourced";
}

function evidenceReason(trust: EvidenceTrust): string {
  return trust === "verified"
    ? "all declared source dependencies carry capture-time content commitments"
    : trust === "sourced"
      ? "the memory is sourced, but its evidence is incomplete or not fully hash-backed"
      : "no source evidence was captured";
}

function staleFromFineGrained(
  evidenceTrust: EvidenceTrust,
  fineGrained: FineGrainedVerification,
): Verdict {
  const sourceStatus: LiveSourceStatus =
    fineGrained.status === "missing" ? "missing" : "drifted";
  const reason = `complete fine-grained evidence no longer validates (${fineGrained.reason})`;
  return {
    status: "stale",
    reason,
    evidenceTrust,
    evidenceReason: evidenceReason(evidenceTrust),
    sourceStatus,
    sourceReason: reason,
    fineGrained,
  };
}

export function classifyProvenance(
  prov: Provenance | undefined,
  root: string,
  opts?: {
    /** Re-root capture-relative files onto a caller checkout only after the
     * caller has established the same stable project identity (#58). */
    verifyAgainstRoot?: boolean;
  },
): Verdict {
  const trust = evidenceTrustOf(prov);
  if (isUnsourced(prov)) {
    const reason = "no file, command, or user-confirmation evidence";
    return {
      status: "unsourced",
      reason,
      evidenceTrust: "unsourced",
      evidenceReason: reason,
      sourceStatus: "unknown",
      sourceReason: "no source evidence was captured",
    };
  }

  const files = Array.isArray(prov?.files) ? prov.files : [];
  const hashes = prov?.fileHashes ?? {};
  const normalizedHashes = prov?.fileHashesNormalized ?? {};
  // Relative paths belong to the capture cwd unless a stable identity match
  // explicitly authorized checking the caller's worktree.
  const base =
    !opts?.verifyAgainstRoot && prov?.cwd && isAbsolute(prov.cwd)
      ? prov.cwd
      : root;
  const captureCwd = prov?.cwd && isAbsolute(prov.cwd) ? prov.cwd : undefined;

  let fineGrained: FineGrainedVerification | undefined;
  if (prov?.anchors !== undefined) {
    fineGrained = verifyFineGrainedEvidence(prov.anchors, base);
    // Metadata completeness is necessary but not sufficient: declared files
    // are cross-checked here rather than trusting the stored coverage word.
    if (fineGrained.actionable && !anchorsCoverDeclaredFiles(prov)) {
      fineGrained = {
        ...fineGrained,
        actionable: false,
        reason:
          "fine-grained coverage does not exactly match the declared source files",
      };
    }
  }

  const deleted: string[] = [];
  const changed: string[] = [];
  const cosmetic: string[] = [];
  const unsafe: string[] = [];
  let hashMatched = 0;
  let unchecked = 0;
  const boundedFiles = files.slice(0, MAX_VERIFY_FILES);
  if (files.length > MAX_VERIFY_FILES) unsafe.push("file evidence cap exceeded");

  for (const file of boundedFiles) {
    if (typeof file !== "string" || !file) {
      unsafe.push("malformed file reference");
      continue;
    }
    let verificationRoot = base;
    let verificationFile = file;
    // Absolute capture-internal paths follow an identity-authorized worktree
    // re-root. Absolute external evidence never silently changes identity.
    if (opts?.verifyAgainstRoot && captureCwd && isAbsolute(file)) {
      const rel = relativeInside(captureCwd, file);
      if (rel) {
        verificationRoot = root;
        verificationFile = rel;
      }
    }
    const read = readEvidenceFile(
      verificationRoot,
      verificationFile,
      MAX_SOURCE_HASH_BYTES,
    );
    if (!read.ok) {
      if (read.reason === "missing") deleted.push(file);
      else if (read.reason === "unsafe") unsafe.push(file);
      else unchecked++;
      continue;
    }
    const recorded = hashes[file];
    if (typeof recorded !== "string" || !SHA256_RE.test(recorded)) {
      unchecked++;
      continue;
    }
    const current = sha256(read.bytes);
    if (current === recorded) {
      hashMatched++;
      continue;
    }
    const expectedNormalized = normalizedHashes[file];
    const actualNormalized =
      typeof expectedNormalized === "string" && SHA256_RE.test(expectedNormalized)
        ? normalizedTextHash(read.bytes)
        : null;
    if (actualNormalized && actualNormalized === expectedNormalized) cosmetic.push(file);
    else changed.push(file);
  }

  // Complete anchors are primary dependencies. Their own drift invalidates even
  // if a contradictory whole-file record happens to match; partial anchors are
  // advisory and never affect the conservative whole-file result.
  if (fineGrained?.actionable) {
    if (
      fineGrained.status === "drifted" ||
      fineGrained.status === "missing" ||
      fineGrained.status === "ambiguous"
    ) {
      return staleFromFineGrained(trust, fineGrained);
    }
    if (fineGrained.status === "raw_match") {
      const reason =
        changed.length + cosmetic.length + deleted.length + unsafe.length > 0
          ? "complete fine-grained anchors match; unrelated whole-file drift is advisory"
          : "all complete fine-grained anchors match their captured hashes";
      return {
        status: "verified",
        reason,
        evidenceTrust: "verified",
        evidenceReason: evidenceReason("verified"),
        sourceStatus: "matched",
        sourceReason: reason,
        fineGrained,
      };
    }
    // A declared normalization can prove a bounded cosmetic match, but it does
    // not claim byte identity. Keep it active under balanced recall and surface
    // the distinction rather than laundering it into raw `verified`.
    const reason =
      "complete fine-grained anchors match only after their declared cosmetic normalization";
    return {
      status: "sourced_unverified",
      reason,
      evidenceTrust: "verified",
      evidenceReason: evidenceReason("verified"),
      sourceStatus: "matched",
      sourceReason: reason,
      fineGrained,
    };
  }

  if (
    deleted.length > 0 ||
    changed.length > 0 ||
    cosmetic.length > 0 ||
    unsafe.length > 0
  ) {
    const parts: string[] = [];
    if (deleted.length > 0) parts.push(`deleted: ${deleted.slice(0, 2).join(", ")}`);
    if (changed.length > 0) parts.push(`changed: ${changed.slice(0, 2).join(", ")}`);
    if (cosmetic.length > 0) {
      parts.push(`cosmetic: ${cosmetic.slice(0, 2).join(", ")}`);
    }
    if (unsafe.length > 0) parts.push(`unsafe: ${unsafe.slice(0, 2).join(", ")}`);
    const reason = `references files that no longer match (${parts.join("; ")})`;
    const sourceStatus: LiveSourceStatus =
      deleted.length > 0
        ? "missing"
        : changed.length > 0 || unsafe.length > 0
          ? "drifted"
          : "cosmetic_drift";
    return {
      status: "stale",
      reason,
      evidenceTrust: trust,
      evidenceReason: evidenceReason(trust),
      sourceStatus,
      sourceReason: reason,
      ...(fineGrained ? { fineGrained } : {}),
    };
  }

  if (prov?.mixedTrust === true) {
    const reason =
      "the memory's evidence is incomplete (mixed or capped at capture); file hashes cannot vouch for all of it";
    return {
      status: "sourced_unverified",
      reason,
      evidenceTrust: "sourced",
      evidenceReason: reason,
      sourceStatus:
        files.length > 0 && hashMatched === files.length ? "matched" : "unknown",
      sourceReason:
        files.length > 0 && hashMatched === files.length
          ? "all captured source commitments match, but they do not cover the whole memory"
          : "the captured source subset cannot establish complete live freshness",
      ...(fineGrained ? { fineGrained } : {}),
    };
  }

  if (hashMatched > 0 && unchecked === 0 && hashMatched === files.length) {
    const reason = "all referenced files exist and match their captured hashes";
    return {
      status: "verified",
      reason,
      evidenceTrust: "verified",
      evidenceReason: evidenceReason("verified"),
      sourceStatus: "matched",
      sourceReason: reason,
      ...(fineGrained ? { fineGrained } : {}),
    };
  }
  const reason =
    hashMatched > 0
      ? "some referenced files verified, but others could not be content-checked"
      : files.length > 0
        ? "referenced files exist but were not hashed at capture (existence only)"
        : "sourced by command or user, no file evidence to verify against";
  return {
    status: "sourced_unverified",
    reason,
    evidenceTrust: trust,
    evidenceReason:
      trust === "verified"
        ? "all declared source dependencies carry capture-time commitments, but the live source could not be fully checked"
        : "the memory has source or confirmation evidence without complete file commitments",
    sourceStatus: "unknown",
    sourceReason: reason,
    ...(fineGrained ? { fineGrained } : {}),
  };
}
