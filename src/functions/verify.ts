//
// Verified Recall: classify capture commitments against live source. Raw and
// normalized whole-file commitments are computed from one read (#71/#72).
// Fine-grained anchors are layered on top and may override unrelated file drift
// only when source coverage and the exact stored claim are capture-complete.
//
//   verified           complete dependencies match raw bytes
//   cosmetic           complete dependencies match declared normalization
//   sourced_unverified sourced, but not fully content-current
//   stale              a complete dependency changed or disappeared
//   unsourced          no evidence at all
//

import { isAbsolute, relative, sep } from "node:path";
import type {
  FineGrainedClaimCommitment,
  Provenance,
} from "./types.js";
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

interface FileCommitment {
  raw: string;
  normalized?: string;
}

export interface FileHashCommitments {
  fileHashes: Record<string, string>;
  fileHashesNormalized: Record<string, string>;
}

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

/** Relative evidence is constrained to its checkout. Absolute evidence under
 * that checkout gets the same symlink-escape protection; intentionally external
 * absolute evidence keeps its historical identity for compatibility. */
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

function commitmentForRead(read: Extract<BoundedReadResult, { ok: true }>): FileCommitment {
  const normalized = normalizedTextHash(read.bytes);
  return {
    raw: sha256(read.bytes),
    ...(normalized ? { normalized } : {}),
  };
}

/** Hash raw bytes and normalized UTF-8 content from the SAME source read, so
 * those trust-bearing commitments cannot describe two racing snapshots. */
export function hashFileCommitments(
  files: string[] | undefined,
  root: string,
): FileHashCommitments {
  const fileHashes: Record<string, string> = {};
  const fileHashesNormalized: Record<string, string> = {};
  if (!Array.isArray(files)) return { fileHashes, fileHashesNormalized };
  for (const file of files.slice(0, MAX_VERIFY_FILES)) {
    const read = readEvidenceFile(root, file);
    if (!read.ok) continue;
    const commitment = commitmentForRead(read);
    fileHashes[file] = commitment.raw;
    if (commitment.normalized) {
      fileHashesNormalized[file] = commitment.normalized;
    }
  }
  return { fileHashes, fileHashesNormalized };
}

/** Backward-compatible raw-byte helper. */
export function hashFiles(
  files: string[] | undefined,
  root: string,
): Record<string, string> {
  return hashFileCommitments(files, root).fileHashes;
}

/** Backward-compatible normalized helper, still sharing each read with raw. */
export function hashFilesNormalized(
  files: string[] | undefined,
  root: string,
): Record<string, string> {
  return hashFileCommitments(files, root).fileHashesNormalized;
}

/** Shared Canon/live normalization primitive for one absolute source file. */
export function normalizedFileHash(absolutePath: string): string | null {
  const read = readBoundedFile(absolutePath, MAX_SOURCE_HASH_BYTES);
  return read.ok ? normalizedTextHash(read.bytes) : null;
}

export type VerifyStatus =
  | "verified"
  | "cosmetic"
  | "sourced_unverified"
  | "stale"
  | "unsourced";

export type EvidenceTrust = "verified" | "sourced" | "unsourced";
export type LiveSourceStatus =
  | "matched"
  | "cosmetic_drift"
  | "drifted"
  | "missing"
  | "unknown";

export interface Verdict {
  status: VerifyStatus;
  reason: string;
  evidenceTrust: EvidenceTrust;
  evidenceReason: string;
  sourceStatus: LiveSourceStatus;
  sourceReason: string;
  /** Recomputed diagnostics; never a persisted trust verdict. */
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

/** Cross-check capture coverage rather than trusting its stored completeness
 * word. Mixed/capped evidence can never become actionable. */
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

/** Capture evidence quality only; no checkout read occurs here. */
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
  trust: EvidenceTrust,
  fineGrained: FineGrainedVerification,
): Verdict {
  const sourceStatus: LiveSourceStatus =
    fineGrained.status === "missing" ? "missing" : "drifted";
  const reason = `complete fine-grained evidence no longer validates (${fineGrained.reason})`;
  return {
    status: "stale",
    reason,
    evidenceTrust: trust,
    evidenceReason: evidenceReason(trust),
    sourceStatus,
    sourceReason: reason,
    fineGrained,
  };
}

export function classifyProvenance(
  prov: Provenance | undefined,
  root: string,
  opts?: {
    /** Caller proved this is another checkout of the same #58 identity. */
    verifyAgainstRoot?: boolean;
    /** Exact stored observation/Memory/Canon claim projection. Without it,
     * fine-grained completeness is advisory and whole-file fallback wins. */
    fineGrainedClaim?: FineGrainedClaimCommitment;
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
  const base =
    !opts?.verifyAgainstRoot && prov?.cwd && isAbsolute(prov.cwd)
      ? prov.cwd
      : root;
  const captureCwd = prov?.cwd && isAbsolute(prov.cwd) ? prov.cwd : undefined;

  let fineGrained: FineGrainedVerification | undefined;
  if (prov?.anchors !== undefined) {
    fineGrained = verifyFineGrainedEvidence(
      prov.anchors,
      base,
      opts?.fineGrainedClaim,
    );
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
  const unsafe: string[] = [];
  let exactMatched = 0;
  let normalizedMatched = 0;
  let unchecked = 0;
  let inconsistentCommitments = false;
  const boundedFiles = files.slice(0, MAX_VERIFY_FILES);
  if (files.length > MAX_VERIFY_FILES) unsafe.push("file evidence cap exceeded");

  for (const file of boundedFiles) {
    if (typeof file !== "string" || !file) {
      unsafe.push("malformed file reference");
      inconsistentCommitments = true;
      continue;
    }
    let verificationRoot = base;
    let verificationFile = file;
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

    const recordedRaw = hashes[file];
    const recordedNormalized = normalizedHashes[file];
    const validRaw =
      typeof recordedRaw === "string" && SHA256_RE.test(recordedRaw);
    const validNormalized =
      typeof recordedNormalized === "string" &&
      SHA256_RE.test(recordedNormalized);
    if (!validRaw && !validNormalized) {
      unchecked++;
      continue;
    }
    if (
      (recordedRaw !== undefined && !validRaw) ||
      (recordedNormalized !== undefined && !validNormalized)
    ) {
      inconsistentCommitments = true;
      changed.push(file);
      continue;
    }

    const current = commitmentForRead(read);
    if (validRaw && current.raw === recordedRaw) {
      // A trust-bearing normalized fallback must describe these same raw bytes.
      if (validNormalized && current.normalized !== recordedNormalized) {
        inconsistentCommitments = true;
        changed.push(file);
      } else {
        exactMatched++;
      }
    } else if (
      validNormalized &&
      current.normalized !== undefined &&
      current.normalized === recordedNormalized
    ) {
      normalizedMatched++;
    } else {
      changed.push(file);
    }
  }

  // Actionable anchor drift is itself a dirty dependency. A raw/cosmetic match
  // may override unrelated whole-file drift, but never malformed contradictory
  // commitments.
  if (fineGrained?.actionable) {
    if (
      fineGrained.status === "drifted" ||
      fineGrained.status === "missing" ||
      fineGrained.status === "ambiguous"
    ) {
      return staleFromFineGrained(trust, fineGrained);
    }
    if (!inconsistentCommitments && fineGrained.status === "raw_match") {
      const reason =
        changed.length + deleted.length + unsafe.length > 0
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
    if (!inconsistentCommitments && fineGrained.status === "cosmetic_match") {
      const reason =
        "complete fine-grained anchors match their declared cosmetic normalization";
      return {
        status: "cosmetic",
        reason,
        evidenceTrust: "verified",
        evidenceReason: evidenceReason("verified"),
        sourceStatus: "cosmetic_drift",
        sourceReason: reason,
        fineGrained,
      };
    }
  }

  if (
    deleted.length > 0 ||
    changed.length > 0 ||
    unsafe.length > 0
  ) {
    const parts: string[] = [];
    if (deleted.length > 0) parts.push(`deleted: ${deleted.slice(0, 2).join(", ")}`);
    if (changed.length > 0) parts.push(`changed: ${changed.slice(0, 2).join(", ")}`);
    if (unsafe.length > 0) parts.push(`unsafe: ${unsafe.slice(0, 2).join(", ")}`);
    const reason = `references files that no longer match (${parts.join("; ")})`;
    return {
      status: "stale",
      reason,
      evidenceTrust: trust,
      evidenceReason: evidenceReason(trust),
      sourceStatus: deleted.length > 0 ? "missing" : "drifted",
      sourceReason: reason,
      ...(fineGrained ? { fineGrained } : {}),
    };
  }

  if (prov?.mixedTrust === true) {
    const reason =
      "the memory's evidence is incomplete (mixed or capped at capture); file commitments cannot vouch for all of it";
    const allCapturedSourcesChecked =
      files.length > 0 &&
      unchecked === 0 &&
      exactMatched + normalizedMatched === files.length;
    const sourceStatus: LiveSourceStatus = allCapturedSourcesChecked
      ? normalizedMatched > 0
        ? "cosmetic_drift"
        : "matched"
      : "unknown";
    return {
      status: "sourced_unverified",
      reason,
      evidenceTrust: "sourced",
      evidenceReason: reason,
      sourceStatus,
      sourceReason: allCapturedSourcesChecked
        ? normalizedMatched > 0
          ? "all captured normalized source commitments match, but they do not cover the whole memory"
          : "all captured raw source commitments match, but they do not cover the whole memory"
        : "the captured source subset cannot establish complete live freshness",
      ...(fineGrained ? { fineGrained } : {}),
    };
  }

  if (
    files.length > 0 &&
    unchecked === 0 &&
    exactMatched + normalizedMatched === files.length &&
    normalizedMatched > 0
  ) {
    const reason =
      "all referenced files match their captured normalized content; only line endings or trailing whitespace differ";
    return {
      status: "cosmetic",
      reason,
      evidenceTrust: trust,
      evidenceReason:
        trust === "verified"
          ? "all declared source files carry capture-time raw-byte and normalized-text commitments"
          : "normalized source commitments match, but capture evidence is not fully raw-hash-backed",
      sourceStatus: "cosmetic_drift",
      sourceReason: reason,
      ...(fineGrained ? { fineGrained } : {}),
    };
  }

  if (
    files.length > 0 &&
    unchecked === 0 &&
    exactMatched === files.length
  ) {
    const reason =
      "all referenced files exist and match their captured hashes exactly (raw bytes)";
    return {
      status: "verified",
      reason,
      evidenceTrust: trust,
      evidenceReason:
        "all declared source files carry capture-time raw-byte commitments",
      sourceStatus: "matched",
      sourceReason: reason,
      ...(fineGrained ? { fineGrained } : {}),
    };
  }

  const reason =
    exactMatched + normalizedMatched > 0
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
        ? "all declared source files carry capture-time commitments, but the live source could not be fully checked"
        : "the memory has source or confirmation evidence without complete file commitments",
    sourceStatus: "unknown",
    sourceReason: reason,
    ...(fineGrained ? { fineGrained } : {}),
  };
}
