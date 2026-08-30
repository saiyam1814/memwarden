//
// Verified Memory Canon — the portable half of Verified Recall.
//
// Until now the hash chain only proved anything on the machine that made it.
// A memory verified against MY checkout said nothing to YOUR agent, so every
// teammate (and every fresh clone, and CI) started from an empty brain and
// spent weeks re-learning what the team already knew.
//
// The canon fixes that by moving distilled memories OUT of the private brain
// and INTO the repo as a committed, reviewable artifact:
//
//   .memwarden/canon.jsonl   one JSON record per line, newline-delimited so
//                            git diffs it per-memory and merges it like code
//
// Each record carries repo-relative file paths and the capture-time SHA-256 of
// each file. That is the whole trick: any checkout can re-hash those files and
// decide for itself whether the memory still holds. Trust becomes portable
// without a server, an account, or a vendor — `canon verify` is the same
// firewall verdict, computed locally, by whoever cloned the repo.
//
// It also draws the line the 0.0.5 sieve bug proved we needed: raw captures are
// private, ephemeral scratch under ~/.memwarden; distilled memories are the
// durable layer; and PROMOTION into the repo is a reviewable event. A bad
// memory gets caught in code review, like a bad migration.
//
// Honesty boundary, stated in the output and the docs: a matching hash proves
// the memory's source is UNCHANGED, not that the memory's claim is CORRECT. A
// wrong decision recorded against a file that never changed stays wrong. The
// canon narrows staleness, which is the failure mode that silently misleads
// agents; it is not a correctness oracle.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  hashFileCommitments,
  normalizedFileHash,
} from "../functions/verify.js";
import {
  bindFineGrainedEvidenceToCanon,
  canonicalFineGrainedEvidence,
  cloneFineGrainedEvidence,
  fineGrainedClaimForCanon,
  fineGrainedClaimForMemory,
  mapFineGrainedEvidencePaths,
  verifyFineGrainedEvidence,
  type FineGrainedAnchorStatus,
} from "../functions/anchors.js";
import {
  projectIdentityMatchesPath,
  resolveMemoryIdentity,
} from "../functions/memory-identity.js";
import {
  CANON_FORMAT,
  isCanonRecord,
  isPortableCanonPath,
} from "../functions/canon.js";
import { projectKey } from "../functions/git-identity.js";
import type {
  CanonRecord,
  FineGrainedEvidence,
  MemoryLifecycleState,
  MemoryLifecycleTransition,
  MemoryValidityInterval,
} from "../functions/types.js";

export { CANON_FORMAT };
export type { CanonRecord };

// --- secret gate ----------------------------------------------------
//
// `canon push` writes into a file that gets COMMITTED, and git history is a
// one-way door: a leaked credential is an incident and a history rewrite, not a
// delete. Memory content is compressed tool output, and tool output includes
// `cat .env`, terraform plans, stack traces with connection strings. So the
// canon has a hard gate on the way in.
//
// Targeted detectors, not entropy heuristics: entropy alone floods on hashes,
// UUIDs and minified code, and users who learn to bypass a noisy gate bypass it
// when it matters. There is deliberately NO override flag — `--all` relaxes the
// STALENESS gate only. A memory carrying a credential is a memory to forget,
// not to force through.
const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "private key block", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "OpenAI-style API key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { label: "OpenRouter key", re: /\bsk-or-v1-[A-Za-z0-9]{32,}\b/ },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    label: "credentialed connection string",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i,
  },
  {
    label: "assigned credential",
    re: /\b(?:api[_-]?key|secret|password|passwd|token|bearer)\b["'\s]*[:=]["'\s]*[^\s"',;)]{12,}/i,
  },
];

export interface SecretHit {
  label: string;
  field: string;
}

/** Every secret-ish pattern found across the fields that would be committed.
 *  Returns the LABEL and field only — never the matched text, because a report
 *  that reprints the credential defeats its own purpose. */
export function scanForSecrets(record: {
  title?: string;
  content?: string;
  concepts?: string[];
}): SecretHit[] {
  const fields: Array<[string, string]> = [
    ["title", record.title ?? ""],
    ["content", record.content ?? ""],
    ["concepts", (record.concepts ?? []).join(" ")],
  ];
  const hits: SecretHit[] = [];
  for (const [field, text] of fields) {
    if (!text) continue;
    for (const { label, re } of SECRET_PATTERNS) {
      if (re.test(text)) hits.push({ label, field });
    }
  }
  return hits;
}

/** Shared core primitive: Canon and live provenance must agree on exactly
 * what counts as cosmetic text drift, without making core import CLI code. */
export { normalizedFileHash };

/** Bumped only for breaking record-shape changes; readers tolerate unknown
 *  extra fields so a format-compatible newer writer never breaks an older one.
 *  The constant and shared record type live at the core/API boundary. */
export const CANON_DIR = ".memwarden";
export const CANON_FILE = "canon.jsonl";

export type CanonVerdict =
  /** every listed file is byte-identical to capture time */
  | "verified"
  /** content matches once formatting is normalized — the code did not change */
  | "cosmetic"
  /** a listed file's content genuinely changed, or it is gone */
  | "stale"
  /** no hashes at all: nothing to check, so never treated as good */
  | "missing";

export interface CanonCheck {
  record: CanonRecord;
  verdict: CanonVerdict;
  /** Files that no longer hash-match (stale/cosmetic) or are absent. */
  drifted: string[];
  /** Locally recomputed; never read from the Canon record. */
  anchorStatus?: FineGrainedAnchorStatus;
  anchorActionable?: boolean;
}

export function canonPath(root: string): string {
  return join(root, CANON_DIR, CANON_FILE);
}

/** Repo-relative + forward-slashed. Absolute paths in a committed artifact are
 *  worse than useless: they leak the author's home directory AND fail to
 *  resolve anywhere else. */
export function toRepoRelative(file: string, root: string): string | null {
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  // Outside the repo (or a traversal attempt) has no place in a repo artifact.
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== abs) return null;
  return rel.split(sep).join("/");
}

/** One record per line. Unparseable lines are skipped, not fatal: a
 *  half-resolved merge conflict must never make the whole canon unreadable. */
export function parseCanon(text: string): {
  records: CanonRecord[];
  skipped: number;
} {
  const records: CanonRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r: unknown = JSON.parse(s);
      if (isCanonRecord(r)) records.push(r);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

export function readCanon(root: string): {
  records: CanonRecord[];
  skipped: number;
  path: string;
  exists: boolean;
} {
  const path = canonPath(root);
  if (!existsSync(path)) {
    return { records: [], skipped: 0, path, exists: false };
  }
  const { records, skipped } = parseCanon(readFileSync(path, "utf8"));
  return { records, skipped, path, exists: true };
}

/**
 * Stable serialization: records sorted by id and keys emitted in a fixed order,
 * so re-running `canon push` on an unchanged brain produces a byte-identical
 * file. Without that, every push would be a spurious diff and reviewers would
 * learn to ignore the artifact — which defeats the entire point of committing it.
 */
export function serializeCanon(records: CanonRecord[]): string {
  const ordered = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = ordered.map((r) => {
    const files = [...r.files].sort();
    const hashes: Record<string, string> = {};
    for (const f of Object.keys(r.fileHashes).sort()) hashes[f] = r.fileHashes[f]!;
    const out: Record<string, unknown> = {
      format: r.format,
      id: r.id,
      type: r.type,
      ...(r.projectKey ? { projectKey: r.projectKey } : {}),
      ...(r.version !== undefined ? { version: r.version } : {}),
      ...(r.observedAt ? { observedAt: r.observedAt } : {}),
      ...(r.validFrom ? { validFrom: r.validFrom } : {}),
      ...(r.validTo ? { validTo: r.validTo } : {}),
      ...(r.validityIntervals
        ? {
            validityIntervals: r.validityIntervals.map((interval) => ({
              validFrom: interval.validFrom,
              ...(interval.validTo ? { validTo: interval.validTo } : {}),
              ...(interval.reason ? { reason: interval.reason } : {}),
              ...(interval.inferred ? { inferred: true } : {}),
            })),
          }
        : {}),
      ...(r.sourceCommit ? { sourceCommit: r.sourceCommit } : {}),
      ...(r.lifecycle ? { lifecycle: r.lifecycle } : {}),
      ...(r.lifecycleReason ? { lifecycleReason: r.lifecycleReason } : {}),
      ...(r.lifecycleChangedAt
        ? { lifecycleChangedAt: r.lifecycleChangedAt }
        : {}),
      ...(r.lifecycleTransitions
        ? {
            lifecycleTransitions: r.lifecycleTransitions.map((transition) => ({
              ...transition,
            })),
          }
        : {}),
      ...(r.lifecycleMigratedFromLegacy
        ? { lifecycleMigratedFromLegacy: true }
        : {}),
      ...(r.parentId ? { parentId: r.parentId } : {}),
      ...(r.supersedes ? { supersedes: [...r.supersedes].sort() } : {}),
      ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
      ...(r.relatedIds ? { relatedIds: [...r.relatedIds].sort() } : {}),
      title: r.title,
      content: r.content,
      concepts: [...r.concepts].sort(),
      files,
      fileHashes: hashes,
      promotedAt: r.promotedAt,
    };
    if (r.fileHashesNormalized) {
      const norm: Record<string, string> = {};
      for (const f of Object.keys(r.fileHashesNormalized).sort()) {
        norm[f] = r.fileHashesNormalized[f]!;
      }
      out["fileHashesNormalized"] = norm;
    }
    const anchors = canonicalFineGrainedEvidence(r.anchors);
    if (anchors) out["anchors"] = anchors;
    if (r.reanchoredBy) out["reanchoredBy"] = r.reanchoredBy;
    if (r.reanchoredAt) out["reanchoredAt"] = r.reanchoredAt;
    if (r.capturedBy && (r.capturedBy.host || r.capturedBy.agentId)) {
      out["capturedBy"] = {
        ...(r.capturedBy.host ? { host: r.capturedBy.host } : {}),
        ...(r.capturedBy.agentId ? { agentId: r.capturedBy.agentId } : {}),
      };
    }
    return JSON.stringify(out);
  });
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

export function writeCanon(root: string, records: CanonRecord[]): string {
  const path = canonPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeCanon(records), "utf8");
  writeCanonReadme(root);
  return path;
}

export type CanonWriteMode = "merge" | "replace";

/** Default push semantics are a keyed merge: local stored Memory updates the
 * same ids, while team Canon records absent from this brain survive untouched.
 * Destructive replacement exists only as an explicit CLI mode. */
export function mergeCanonRecords(
  existing: CanonRecord[],
  promoted: CanonRecord[],
  mode: CanonWriteMode = "merge",
): CanonRecord[] {
  const byId = new Map<string, CanonRecord>();
  if (mode === "merge") {
    for (const record of existing) byId.set(record.id, record);
  }
  for (const record of promoted) byId.set(record.id, record);
  return [...byId.values()];
}

/**
 * A README beside the canon, for the human who meets this file in code review
 * with no idea what it is. Without it the reasonable reviewer reaction is "this
 * is an unreproducible cache committed to git" — and they would be half right,
 * so the file has to make its own case.
 */
export function writeCanonReadme(root: string): string {
  const path = join(root, CANON_DIR, "README.md");
  if (existsSync(path)) return path; // never clobber a team's own edits
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# .memwarden — the repository's verified memory

\`canon.jsonl\` is an **agent-readable, tamper-evident ARCHITECTURE.md**: decisions
and knowledge your AI coding agents learned while working in this repo. Every
record carries source-file SHA-256 commitments; some also carry bounded,
content-addressed source-unit anchors.

It is committed on purpose. Any checkout can re-hash those commitments and
decide for itself whether a memory still holds:

\`\`\`bash
memwarden canon verify          # verified / cosmetic drift / stale, per memory
memwarden canon verify --strict # exit 1 on real drift (CI gate)
memwarden canon pull            # load what still holds into your local agent memory
\`\`\`

## Reviewing a change to this file

- Each line is one memory. Read it like a doc change, because that is what it is.
- A memory whose source changed is reported **stale** and is refused at recall,
  so a forgotten record misleads nobody — but it should be refreshed or dropped.
- Treat added \`content\` as prose entering the repo's canon: if you would not
  merge it into a design doc, do not merge it here.

## Please protect this path

Records here are ingested by agents. Add to \`CODEOWNERS\` so a human always
reviews changes:

\`\`\`
/.memwarden/  @your-team
\`\`\`

## What a green verdict does and does not mean

A matching commitment proves the declared source unit is **unchanged since capture**
(or matches its explicit cosmetic normalization). A complete fine-grained anchor
can remain green when unrelated bytes elsewhere in the same file change. This
does not prove the memory's claim is **correct**; partial or ambiguous anchors
never override whole-file drift.

Generated by [memwarden](https://github.com/saiyam1814/memwarden). Safe to edit
by hand; \`canon push\` will not overwrite this README.
`,
    "utf8",
  );
  return path;
}

/**
 * Recompute a record's hashes against THIS checkout and stamp who asserted it.
 *
 * Canon has no self-healing path without this: `push` promotes from the local
 * brain, brains are per-machine, so after a refactor nobody but the original
 * captor could refresh the hashes — and they may have left the team. The
 * result is permanent rot and a CI gate people delete.
 *
 * Re-anchoring is deliberately NOT verification: it records a human claim that
 * the memory still holds, and `verify` reports it as attested so the two are
 * never confused.
 */
export function reanchorRecord(
  record: CanonRecord,
  root: string,
  by: string,
  nowIso: string,
): CanonRecord | null {
  const names = Object.keys(record.fileHashes ?? {});
  if (names.length === 0) return null;
  const fresh = hashFileCommitments(names, root);
  // Every listed file must still exist and be hashable. A memory whose source
  // is gone is not re-anchorable — it is dead, and should be dropped in review.
  const fileHashes: Record<string, string> = {};
  for (const f of names) {
    const hash = fresh.fileHashes[f];
    if (!hash) return null;
    fileHashes[f] = hash;
  }
  const fileHashesNormalized = fresh.fileHashesNormalized;
  const anchorCheck = record.anchors
    ? verifyFineGrainedEvidence(
        record.anchors,
        root,
        fineGrainedClaimForCanon(record),
      )
    : undefined;
  // Preserve only byte-identical anchors. A human re-anchor of a cosmetic or
  // changed unit deliberately falls back to the freshly committed whole file;
  // retaining the old normalized-only anchor would leave the record cosmetic
  // forever even after this explicit attestation.
  const retainedAnchors =
    anchorCheck?.status === "raw_match"
      ? cloneFineGrainedEvidence(record.anchors)
      : null;
  const { anchors: _priorAnchors, ...withoutAnchors } = record;
  return {
    ...withoutAnchors,
    fileHashes,
    ...(Object.keys(fileHashesNormalized).length > 0
      ? { fileHashesNormalized }
      : {}),
    ...(retainedAnchors ? { anchors: retainedAnchors } : {}),
    reanchoredBy: by,
    reanchoredAt: nowIso,
  };
}

/**
 * Re-hash every record's files against THIS checkout and label it. This is the
 * portable firewall verdict: same rule as recall-time classification, computed
 * by whoever holds the repo, with no daemon and no network.
 *
 * A record with no hashes at all cannot be verified and is reported `missing`
 * rather than assumed good — unverifiable must never read as verified.
 */
export function verifyCanon(records: CanonRecord[], root: string): CanonCheck[] {
  return records.map((record) => {
    const expected = record.fileHashes ?? {};
    const names = Object.keys(expected);
    if (names.length === 0) {
      return { record, verdict: "missing" as CanonVerdict, drifted: [] };
    }
    const declared = new Set(record.files ?? []);
    const unsafe = names.filter(
      (name) => !isPortableCanonPath(name) || !declared.has(name),
    );
    if (unsafe.length > 0 || declared.size !== names.length) {
      return {
        record,
        verdict: "stale" as CanonVerdict,
        drifted: unsafe.length > 0 ? unsafe : [...declared],
      };
    }
    const actual = hashFileCommitments(names, root);
    const expectedNorm = record.fileHashesNormalized ?? {};
    const drifted: string[] = [];
    let cosmeticOnly = true;
    for (const f of names) {
      const wantNorm = expectedNorm[f];
      const gotNorm = actual.fileHashesNormalized[f];
      if (actual.fileHashes[f] === expected[f]) {
        // A supplied normalized fallback is trust-bearing too. It must describe
        // the exact captured bytes, not remain dormant until a later change.
        if (wantNorm && gotNorm !== wantNorm) {
          drifted.push(f);
          cosmeticOnly = false;
        }
        continue;
      }
      drifted.push(f);
      // Cosmetic only when we have a normalized commitment AND it still
      // matches. No normalized hash (older record, or an unreadable file) means
      // we cannot make that claim, so it counts as real drift.
      if (!wantNorm || gotNorm !== wantNorm) cosmeticOnly = false;
    }
    let verdict: CanonVerdict =
      drifted.length === 0 ? "verified" : cosmeticOnly ? "cosmetic" : "stale";

    const anchorCheck =
      record.anchors !== undefined
        ? verifyFineGrainedEvidence(
            record.anchors,
            root,
            fineGrainedClaimForCanon(record),
          )
        : undefined;
    if (anchorCheck?.actionable) {
      verdict =
        anchorCheck.status === "raw_match"
          ? "verified"
          : anchorCheck.status === "cosmetic_match"
            ? "cosmetic"
            : "stale";
    }
    return {
      record,
      verdict,
      drifted,
      ...(anchorCheck
        ? {
            anchorStatus: anchorCheck.status,
            anchorActionable: anchorCheck.actionable,
          }
        : {}),
    };
  });
}

/** Build a canon record from a stored memory, or null when the memory has no
 *  portable evidence. Memories WITHOUT capture-time file hashes are refused on
 *  purpose: promoting them would put unverifiable claims into the repo wearing
 *  the same clothes as verified ones. */
export function recordFromMemory(
  memory: {
    id: string;
    title: string;
    subtitle?: string;
    content: string;
    facts?: string[];
    concepts?: string[];
    imageDescription?: string;
    files?: string[];
    type?: CanonRecord["type"];
    version?: number;
    observedAt?: string;
    validFrom?: string;
    validTo?: string;
    validityIntervals?: MemoryValidityInterval[];
    sourceCommit?: string;
    lifecycle?: MemoryLifecycleState;
    lifecycleReason?: string;
    lifecycleChangedAt?: string;
    lifecycleTransitions?: MemoryLifecycleTransition[];
    lifecycleMigratedFromLegacy?: true;
    parentId?: string;
    supersedes?: string[];
    supersededBy?: string;
    relatedIds?: string[];
    agentId?: string;
    projectPath?: string;
    projectKey?: string;
    captureCwd?: string;
    /** Legacy overloaded identity, accepted by the migration fallback. */
    project?: string;
    sessionIds?: string[];
    provenance?: {
      cwd?: string;
      files?: string[];
      fileHashes?: Record<string, string>;
      fileHashesNormalized?: Record<string, string>;
      anchors?: FineGrainedEvidence;
      /** `host` is accepted for old stored rows; current Provenance calls this
       * `agent`. */
      host?: string;
      agent?: string;
      mixedTrust?: boolean;
      canon?: {
        projectKey: string;
        promotedAt: string;
        capturedBy?: { host?: string; agentId?: string };
        reanchoredBy?: string;
        reanchoredAt?: string;
      };
    };
  },
  root: string,
  nowIso: string,
): CanonRecord | null {
  const provenance = memory.provenance;
  const hashes = provenance?.fileHashes;
  // Incomplete evidence must never be laundered into a portable verified
  // record merely because one of several source files happened to be hashed.
  if (
    provenance?.mixedTrust === true ||
    !hashes ||
    Object.keys(hashes).length === 0
  ) {
    return null;
  }

  const evidenceFiles = Array.from(
    new Set([...(provenance.files ?? []), ...Object.keys(hashes)]),
  );
  if (evidenceFiles.length === 0) return null;

  const identity = resolveMemoryIdentity(memory);
  const captureCwd = identity.captureCwd;
  const sameProject = projectIdentityMatchesPath(identity, root);
  const fileHashes: Record<string, string> = {};
  const fileHashesNormalized: Record<string, string> = {};
  const capturedNormalized = provenance.fileHashesNormalized ?? {};
  for (const file of evidenceFiles) {
    const hash = hashes[file];
    // Every referenced source needs a capture-time commitment. Silently
    // dropping an unhashed/out-of-repo source would overstate what the evidence
    // covers, so the whole Memory is non-promotable.
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
    let rel = toRepoRelative(file, root);
    // Absolute evidence captured in worktree A is outside worktree B. A stable
    // identity match authorizes translating its capture-relative suffix, but
    // the resulting Canon path is still rooted in the caller's checkout.
    if (!rel && sameProject && captureCwd && isAbsolute(file)) {
      const fromCapture = relative(captureCwd, file);
      if (
        fromCapture &&
        fromCapture !== ".." &&
        !fromCapture.startsWith(`..${sep}`) &&
        !isAbsolute(fromCapture)
      ) {
        rel = toRepoRelative(fromCapture, root);
      }
    }
    if (!rel || !isPortableCanonPath(rel)) return null;
    const prior = fileHashes[rel];
    if (prior && prior !== hash) return null;
    fileHashes[rel] = hash;
    const normalized = capturedNormalized[file];
    if (normalized !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(normalized)) return null;
      const priorNormalized = fileHashesNormalized[rel];
      if (priorNormalized && priorNormalized !== normalized) return null;
      fileHashesNormalized[rel] = normalized;
    }
  }
  const files = Object.keys(fileHashes);
  if (files.length === 0) return null;

  let portableAnchors: FineGrainedEvidence | undefined;
  if (provenance.anchors !== undefined) {
    const captureBase = captureCwd ?? root;
    const mapped = mapFineGrainedEvidencePaths(
      provenance.anchors,
      (path) => {
        // Normal case: map from the capture cwd into this same checkout.
        let rel = toRepoRelative(resolve(captureBase, path), root);
        // Worktree case: the capture absolute path is outside this checkout,
        // but a proven project identity authorizes the same capture-relative
        // suffix under the caller's worktree.
        if (!rel && sameProject) rel = toRepoRelative(path, root);
        return rel;
      },
    );
    // A malformed/out-of-repo anchor set is not silently copied into a
    // committed artifact. The caller can retain the private whole-file memory.
    if (!mapped) return null;
    if (mapped.anchors.some((anchor) => !files.includes(anchor.path))) return null;
    portableAnchors = mapped;
  }

  // New live memories already carry capture-time normalized commitments. For
  // legacy rows, derive one now ONLY when raw bytes still match capture;
  // computing it from drifted source would launder arbitrary changes.
  const current = hashFileCommitments(files, root);
  for (const rel of files) {
    if (current.fileHashes[rel] !== fileHashes[rel]) continue;
    const normalized = current.fileHashesNormalized[rel];
    const captured = fileHashesNormalized[rel];
    if (captured && captured !== normalized) return null;
    if (!captured && normalized) fileHashesNormalized[rel] = normalized;
  }

  const canonOrigin = provenance.canon;
  const capturedBy = canonOrigin?.capturedBy ??
    (provenance.agent || provenance.host || memory.agentId
      ? {
          ...(provenance.agent || provenance.host
            ? { host: provenance.agent ?? provenance.host }
            : {}),
          ...(memory.agentId ? { agentId: memory.agentId } : {}),
        }
      : undefined);
  const localProjectKey = projectKey(root);
  // Only remote-derived keys are portable. `gitroot:/abs/path` and the
  // non-git path fallback are useful for local API scoping but would leak the
  // author's checkout and fail in a clone, so format-1 omits them.
  const portableProjectKey = localProjectKey.startsWith("git:")
    ? localProjectKey
    : undefined;
  const record: CanonRecord = {
    format: CANON_FORMAT,
    id: memory.id,
    type: memory.type ?? "fact",
    ...(portableProjectKey ? { projectKey: portableProjectKey } : {}),
    ...(memory.version !== undefined ? { version: memory.version } : {}),
    ...(memory.observedAt ? { observedAt: memory.observedAt } : {}),
    ...(memory.validFrom ? { validFrom: memory.validFrom } : {}),
    ...(memory.validTo ? { validTo: memory.validTo } : {}),
    ...(memory.validityIntervals
      ? {
          validityIntervals: memory.validityIntervals.map((interval) => ({
            ...interval,
          })),
        }
      : {}),
    ...(memory.sourceCommit ? { sourceCommit: memory.sourceCommit } : {}),
    ...(memory.lifecycle ? { lifecycle: memory.lifecycle } : {}),
    ...(memory.lifecycleReason
      ? { lifecycleReason: memory.lifecycleReason }
      : {}),
    ...(memory.lifecycleChangedAt
      ? { lifecycleChangedAt: memory.lifecycleChangedAt }
      : {}),
    ...(memory.lifecycleTransitions
      ? {
          lifecycleTransitions: memory.lifecycleTransitions.map((transition) => ({
            ...transition,
          })),
        }
      : {}),
    ...(memory.lifecycleMigratedFromLegacy
      ? { lifecycleMigratedFromLegacy: true }
      : {}),
    ...(memory.parentId ? { parentId: memory.parentId } : {}),
    ...(memory.supersedes ? { supersedes: [...memory.supersedes] } : {}),
    ...(memory.supersededBy ? { supersededBy: memory.supersededBy } : {}),
    ...(memory.relatedIds ? { relatedIds: [...memory.relatedIds] } : {}),
    title: memory.title,
    content: memory.content,
    concepts: memory.concepts ?? [],
    files,
    fileHashes,
    ...(Object.keys(fileHashesNormalized).length > 0
      ? { fileHashesNormalized }
      : {}),
    ...(capturedBy ? { capturedBy } : {}),
    promotedAt: canonOrigin?.promotedAt ?? nowIso,
    ...(canonOrigin?.reanchoredBy
      ? { reanchoredBy: canonOrigin.reanchoredBy }
      : {}),
    ...(canonOrigin?.reanchoredAt
      ? { reanchoredAt: canonOrigin.reanchoredAt }
      : {}),
  };
  if (portableAnchors) {
    const sourceClaim = fineGrainedClaimForMemory({
      type: memory.type ?? "fact",
      title: memory.title,
      ...(memory.subtitle !== undefined ? { subtitle: memory.subtitle } : {}),
      content: memory.content,
      ...(memory.facts !== undefined ? { facts: memory.facts } : {}),
      concepts: memory.concepts ?? [],
      files: memory.files ?? [],
      ...(memory.imageDescription !== undefined
        ? { imageDescription: memory.imageDescription }
        : {}),
    });
    const bound = bindFineGrainedEvidenceToCanon(
      portableAnchors,
      record,
      sourceClaim,
    );
    if (!bound) return null;
    record.anchors = bound;
  }
  return isCanonRecord(record) ? record : null;
}
