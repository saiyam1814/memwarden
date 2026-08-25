//
// mem::consolidate-pipeline — turns raw observations into memories.
//
// The gap this closes (#20): capture only ever appends CompressedObservation
// rows under KV.observations. KV.memories (the distilled, superseding,
// decaying layer the doctor/search/stats already read) had exactly one writer
// before this: importBundle. So a brain that never imported a bundle reported
// 0 memories forever, every Read/Edit of a hot file became its own permanent
// observation (113 duplicates for one file were measured), and one edit turned
// all of them stale together.
//
// This sweep first buckets file-backed observations by (project, primary file),
// then partitions each bucket by a deterministic CLAIM + EVIDENCE identity.
// Only members with the same normalized semantic payload and the same trust-
// relevant provenance are folded. Distinct facts about one file, different file
// snapshots, and mixed-trust captures remain separate. N true duplicates still
// collapse to 1 memory, which:
//   - populates KV.memories so /stats and doctor stop reporting a phantom layer
//   - bounds duplicate growth (the folded rows are removed)
//   - fixes correlated rot without replacing unrelated claims about the file
//   - stops recall competing against dozens of genuine duplicates
//
// Firewall safety: a memory contains exactly one evidence-equivalent claim and
// inherits its newest supporting observation's provenance verbatim (files +
// capture-time raw/normalized hashes). Different commitments, file sets,
// cwd/command/agent, or mixedTrust state are different identities and can never
// be laundered through the newest member. Adopted (hashless) observations stay
// hashless.
//
// Conservative by construction: observations that are important (importance
// above the floor), user-confirmed, or ever-accessed are NEVER folded or
// deleted. Groups smaller than the minimum are left untouched. Non-file
// observations (conversations, prompts) are never consolidated.
//
// Tuning (env): MEMWARDEN_CONSOLIDATE_MIN_GROUP (default 3),
// MEMWARDEN_CONSOLIDATE_IMPORTANCE_FLOOR (default 5; above is protected).
// Cadence + on/off live in the boot timers (CONSOLIDATION_*).

import { createHash } from "node:crypto";
import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type {
  CompressedObservation,
  Memory,
  Provenance,
  Session,
} from "./types.js";
import { KV } from "../state/schema.js";
import {
  getSearchIndex,
  vectorIndexRemove,
  vectorIndexAddGuarded,
} from "./search.js";
import { isMemoryRecallable, memoryToObservation } from "./memory-utils.js";
import {
  initializeMemoryLifecycle,
  memoryLifecycleMetadata,
  persistedLifecycleOf,
} from "./memory-lifecycle.js";
import {
  resolveMemoryIdentity,
  sessionProjectIdentity,
  type ProjectIdentity,
} from "./memory-identity.js";
import { getAccessLog, deleteAccessLog } from "./access-tracker.js";
import { logger } from "./logger.js";
import { withKeyedLock } from "./keyed-mutex.js";

// Only these observation types are the duplicate-Read/Edit rot bucket #20
// describes. Conversations, decisions, errors, etc. are left alone.
const CONSOLIDATABLE_TYPES = new Set<CompressedObservation["type"]>([
  "file_read",
  "file_write",
  "file_edit",
]);

function minGroup(): number {
  const n = parseInt(process.env.MEMWARDEN_CONSOLIDATE_MIN_GROUP ?? "3", 10);
  return Number.isFinite(n) && n >= 2 ? n : 3;
}

function importanceFloor(): number {
  // Mirrors auto-forget: importance is the 1-10 capture scale (default 5).
  // Records ABOVE the floor are explicitly-important and protected from
  // folding. A missing/NaN importance is treated as protected (never fold on
  // bad data), same fail-safe posture as the retention sweep.
  const raw = parseFloat(
    process.env.MEMWARDEN_CONSOLIDATE_IMPORTANCE_FLOOR ?? "5",
  );
  return Number.isFinite(raw) ? raw : 5;
}

/** The knowledge type a file-backed observation distills into. */
function memoryTypeFor(obs: CompressedObservation): Memory["type"] {
  return obs.type === "file_read" ? "fact" : "architecture";
}

/** Newest-first is what we want the canonical content from; this returns the
 *  single newest by timestamp (unparseable timestamps sort oldest so a good
 *  row always wins). */
function newestOf(group: CompressedObservation[]): CompressedObservation {
  return group.reduce((best, o) => {
    const bt = new Date(best.timestamp).getTime();
    const ot = new Date(o.timestamp).getTime();
    const bv = Number.isNaN(bt) ? -Infinity : bt;
    const ov = Number.isNaN(ot) ? -Infinity : ot;
    if (ov !== bv) return ov > bv ? o : best;
    // Stable tie-breaker: KV enumeration order must not choose which equivalent
    // source supplies capture metadata when timestamps are equal/bad.
    return o.id > best.id ? o : best;
  });
}

function unique(values: Iterable<string>): string[] {
  return Array.from(new Set(values));
}

/** Claim normalization is deliberately narrow. Whitespace and Unicode form do
 * not change a prose claim; case, punctuation, code symbols, and numbers can.
 * If two payloads differ beyond this, they remain separate. */
function normalizeClaimText(value: string | undefined): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function canonicalClaimStrings(values: readonly string[] | undefined): string[] {
  return unique((values ?? []).map(normalizeClaimText).filter(Boolean)).sort();
}

function canonicalExactStrings(values: readonly string[] | undefined): string[] {
  return unique(
    (values ?? []).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  ).sort();
}

function canonicalFileHashes(
  hashes: Record<string, string> | undefined,
): Array<[string, string]> | null {
  if (hashes === undefined) return null;
  return Object.entries(hashes).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface ObservationIdentity {
  key: string;
  claimFingerprint: string;
  evidenceFingerprint: string;
}

function evidenceFingerprintFor(args: {
  files: readonly string[] | undefined;
  agentId: string | undefined;
  provenance: Provenance | undefined;
}): string {
  const { provenance } = args;
  return sha256({
    v: 1,
    observationFiles: canonicalExactStrings(args.files),
    agentId: args.agentId ?? null,
    provenance:
      provenance === undefined
        ? null
        : {
            cwd: provenance.cwd ?? null,
            files:
              provenance.files === undefined
                ? null
                : canonicalExactStrings(provenance.files),
            fileHashes: canonicalFileHashes(provenance.fileHashes),
            fileHashesNormalized: canonicalFileHashes(
              provenance.fileHashesNormalized,
            ),
            command: provenance.command ?? null,
            agent: provenance.agent ?? null,
            userConfirmed: provenance.userConfirmed ?? null,
            mixedTrust: provenance.mixedTrust ?? null,
          },
  });
}

/**
 * Exact, explainable equivalence for folding. `capturedAt` is the sole omitted
 * provenance field: two captures of the same claim against the same hashes and
 * trust boundary are reinforcement, not different evidence. The newest value
 * remains on the memory, while every supporting observation id remains linked.
 */
function observationIdentity(obs: CompressedObservation): ObservationIdentity {
  const claimFingerprint = sha256({
    v: 1,
    type: obs.type,
    title: normalizeClaimText(obs.title),
    subtitle:
      obs.subtitle === undefined ? null : normalizeClaimText(obs.subtitle),
    narrative: normalizeClaimText(obs.narrative),
    facts: canonicalClaimStrings(obs.facts),
    concepts: canonicalClaimStrings(obs.concepts),
    confidence:
      obs.confidence === undefined ? null : String(obs.confidence),
    imageRef: obs.imageRef ?? null,
    imageData: obs.imageData ?? null,
    imageDescription:
      obs.imageDescription === undefined
        ? null
        : normalizeClaimText(obs.imageDescription),
    modality: obs.modality ?? null,
  });
  const evidenceFingerprint = evidenceFingerprintFor({
    files: obs.files,
    agentId: obs.agentId,
    provenance: obs.provenance,
  });
  return {
    key: `${claimFingerprint}\n${evidenceFingerprint}`,
    claimFingerprint,
    evidenceFingerprint,
  };
}

function contentFor(obs: CompressedObservation, fallbackTitle: string): string {
  const parts = unique(
    [obs.narrative, ...(obs.facts ?? []), obs.imageDescription ?? ""]
      .map(normalizeClaimText)
      .filter(Boolean),
  );
  return parts.join("\n") || fallbackTitle;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function optionalClaimText(value: string | undefined): string | null {
  return value === undefined ? null : normalizeClaimText(value);
}

/**
 * Fingerprint-less rows are never accepted merely because their id happens to
 * occupy a claim slot. Compatibility is reconstructible only when every field
 * that contributes to the incoming claim/evidence projects to the stored row.
 * Older file-write/edit memories cannot prove their original observation type,
 * and rows that flattened non-empty facts cannot prove those facts survived, so
 * both fail closed and are preserved under their existing id.
 */
function fingerprintlessMemoryMatchesIdentity(args: {
  memory: Memory;
  obs: CompressedObservation;
  identity: ObservationIdentity;
  projectIdentity: string;
  primaryFile: string;
}): boolean {
  const { memory, obs, identity, projectIdentity, primaryFile } = args;
  if (
    (memory.claimFingerprint !== undefined &&
      memory.claimFingerprint !== identity.claimFingerprint) ||
    (memory.evidenceFingerprint !== undefined &&
      memory.evidenceFingerprint !== identity.evidenceFingerprint)
  ) {
    return false;
  }
  // `architecture` loses whether the source was file_write or file_edit. Never
  // guess when the fingerprint that disambiguates them is absent.
  if (obs.type !== "file_read" || memory.type !== "fact") return false;
  if (memory.isLatest !== true) return false;

  const title =
    normalizeClaimText(obs.title) || `Knowledge about ${primaryFile}`;
  const facts = canonicalClaimStrings(obs.facts);
  const concepts = canonicalClaimStrings(obs.concepts);
  const files = canonicalExactStrings([
    primaryFile,
    ...(obs.files ?? []),
    ...(obs.provenance?.files ?? []),
  ]);
  const storedIdentity = resolveMemoryIdentity(memory);
  const storedIdentityKey =
    storedIdentity.projectKey ||
    storedIdentity.projectPath ||
    storedIdentity.captureCwd ||
    "_";

  if (normalizeClaimText(memory.title) !== title) return false;
  if (
    normalizeClaimText(memory.content) !==
    normalizeClaimText(contentFor(obs, title))
  ) {
    return false;
  }
  // A legacy row with no structured facts can prove compatibility only when
  // the incoming claim has no independent facts to preserve.
  if (memory.facts === undefined && facts.length > 0) return false;
  if (!sameStrings(canonicalClaimStrings(memory.facts), facts)) return false;
  if (!sameStrings(canonicalClaimStrings(memory.concepts), concepts)) {
    return false;
  }
  if (!sameStrings(canonicalExactStrings(memory.files), files)) return false;
  if (storedIdentityKey !== projectIdentity) return false;
  if (optionalClaimText(memory.subtitle) !== optionalClaimText(obs.subtitle)) {
    return false;
  }
  if (obs.confidence !== undefined && !Number.isFinite(obs.confidence)) {
    return false;
  }
  if (memory.confidence !== obs.confidence) return false;
  if (memory.imageRef !== obs.imageRef) return false;
  if (memory.imageData !== obs.imageData) return false;
  if (
    optionalClaimText(memory.imageDescription) !==
    optionalClaimText(obs.imageDescription)
  ) {
    return false;
  }
  if (memory.modality !== obs.modality) return false;
  if (memory.agentId !== obs.agentId) return false;

  const reconstructedEvidence = evidenceFingerprintFor({
    files: memory.files,
    agentId: memory.agentId,
    provenance: memory.provenance,
  });
  return reconstructedEvidence === identity.evidenceFingerprint;
}

interface Grouped {
  /** Stable key when available, otherwise the legacy project path. Used only
   * for grouping/id generation — never as a filesystem verification root. */
  identityKey: string;
  primaryFile: string;
  members: DistillMember[];
}

export interface DistillMember extends ProjectIdentity {
  sessionId: string;
  obs: CompressedObservation;
}

interface DistillArgs {
  projectIdentity: string;
  primaryFile: string;
  members: DistillMember[];
  now: number;
}

type DistillResult = { memId: string; folded: number } | null;

interface MemorySlot {
  memId: string;
  existing: Memory | null;
}

function claimMemoryDigest(args: {
  projectIdentity: string;
  primaryFile: string;
  identity: ObservationIdentity;
}): string {
  return sha256({
    v: 2,
    projectIdentity: args.projectIdentity,
    primaryFile: args.primaryFile,
    claimFingerprint: args.identity.claimFingerprint,
    evidenceFingerprint: args.identity.evidenceFingerprint,
  });
}

async function resolveMemorySlot(args: {
  kv: StateKV;
  projectIdentity: string;
  primaryFile: string;
  obs: CompressedObservation;
  identity: ObservationIdentity;
}): Promise<MemorySlot | null> {
  const { kv, projectIdentity, primaryFile, obs, identity } = args;
  const digest = claimMemoryDigest({ projectIdentity, primaryFile, identity });
  // v0.0.9 and earlier used fingerprintId(...): `mem_` + 16 hex chars (20
  // total). Claim ids use the full digest (`mem_` + 64 hex, 68 total), so a
  // genuine old per-file id cannot collide. The fallback protects arbitrary ids
  // restored through Brain Bundle import or manually seeded stores.
  const candidates = [`mem_${digest}`, `mem_claim_${digest}`] as const;

  for (let index = 0; index < candidates.length; index++) {
    const memId = candidates[index]!;
    let existing: Memory | null;
    try {
      existing = await kv.get<Memory>(KV.memories, memId);
    } catch (err) {
      // Treat an unavailable predecessor as a hard stop, never as a miss:
      // writing a partial replacement could erase accumulated lineage.
      logger.warn("distill: failed to read existing memory", {
        memId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!existing) return { memId, existing: null };

    if (
      existing.claimFingerprint === identity.claimFingerprint &&
      existing.evidenceFingerprint === identity.evidenceFingerprint
    ) {
      return { memId, existing };
    }

    const hasMissingFingerprint =
      existing.claimFingerprint === undefined ||
      existing.evidenceFingerprint === undefined;
    if (
      hasMissingFingerprint &&
      fingerprintlessMemoryMatchesIdentity({
        memory: existing,
        obs,
        identity,
        projectIdentity,
        primaryFile,
      })
    ) {
      logger.info("distill: migrating compatible fingerprint-less memory", {
        memId,
      });
      return { memId, existing };
    }

    if (index === 0) {
      // Never overwrite an imported/corrupt occupant. A separate deterministic
      // slot lets the new claim become durable while the occupant survives.
      logger.warn("distill: preserving incompatible memory identity", {
        memId,
        fallback: candidates[1],
      });
      continue;
    }

    // Both deterministic slots are occupied by incompatible content. Preserve
    // them and leave all source observations for retry/manual inspection.
    logger.warn("distill: claim fallback also occupied; sources retained", {
      memId,
    });
    return null;
  }
  return null;
}

/**
 * Distill one evidence-equivalent claim into a canonical Memory, then prune its
 * source observations in lockstep with every index. A defensive identity check
 * rejects mixed input even if a caller forgets to partition it first.
 *
 * Extracted so the retention sweep can reuse it. The durability contract is
 * "code-backed knowledge is distilled, never dropped": TTL promotion writes one
 * durable row per claim/evidence identity, while repeated support converges on
 * that same id.
 *
 * Returns null when equivalence is not established or the successor memory
 * could not be written. In either case nothing is pruned; the existing memory
 * and every source observation remain intact for a later retry.
 */
export function distillMembers(
  kv: StateKV,
  args: DistillArgs,
): Promise<DistillResult> {
  if (args.members.length === 0) return Promise.resolve(null);
  const identity = observationIdentity(args.members[0]!.obs);
  const lockKey = `distill:${sha256({
    projectIdentity: args.projectIdentity,
    primaryFile: args.primaryFile,
    identity: identity.key,
  })}`;
  return withKeyedLock(lockKey, () => distillMembersUnlocked(kv, args));
}

async function distillMembersUnlocked(
  kv: StateKV,
  args: DistillArgs,
): Promise<DistillResult> {
  const { projectIdentity, primaryFile, members, now } = args;
  if (members.length === 0) return null;
  const nowIso = new Date(now).toISOString();
  const idx = getSearchIndex();

  const groupObs = members.map((m) => m.obs);
  const identity = observationIdentity(groupObs[0]!);
  if (groupObs.some((obs) => observationIdentity(obs).key !== identity.key)) {
    logger.warn("distill: refused non-equivalent claims", {
      projectIdentity,
      primaryFile,
      members: members.length,
    });
    return null;
  }

  const newest = newestOf(groupObs);
  const newestMember =
    members.find((member) => member.obs === newest) ?? members[0]!;
  // The claim/evidence digest uses the same stable project identity as the
  // grouping map. It is never passed to the verifier as though it were a path.
  const slot = await resolveMemorySlot({
    kv,
    projectIdentity,
    primaryFile,
    obs: newest,
    identity,
  });
  if (!slot) return null;
  const { memId, existing } = slot;
  if (existing && persistedLifecycleOf(existing) !== "active") {
    logger.info("distill: preserving non-active memory and source observations", {
      memId,
      lifecycle: persistedLifecycleOf(existing),
    });
    return null;
  }
  const existingIdentity = existing
    ? resolveMemoryIdentity(existing)
    : undefined;

  const title =
    normalizeClaimText(newest.title) || `Knowledge about ${primaryFile}`;
  const facts = canonicalClaimStrings(newest.facts);
  const concepts = canonicalClaimStrings(newest.concepts);
  const files = canonicalExactStrings([
    ...(existing?.files ?? []),
    primaryFile,
    ...groupObs.flatMap((obs) => obs.files ?? []),
    ...groupObs.flatMap((obs) => obs.provenance?.files ?? []),
  ]);
  const sourceObservationIds = unique([
    ...(existing?.sourceObservationIds ?? existing?.supersedes ?? []),
    ...groupObs.map((obs) => obs.id),
  ]).sort();
  const supersedes = unique([
    ...(existing?.supersedes ?? []),
    ...sourceObservationIds,
  ]).sort();
  const sessionIds = unique([
    ...(existing?.sessionIds ?? []),
    ...members.map((member) => member.sessionId),
  ]).sort();
  // Strength climbs with reinforcement, not with unrelated same-file claims.
  // Never lower an imported row's standing; calculated reinforcement is capped
  // at the existing 1-10 scale.
  const strength = Math.max(
    existing?.strength ?? 0,
    Math.min(
      10,
      5 + Math.floor(Math.log2(Math.max(2, sourceObservationIds.length))),
    ),
  );
  // Identity follows the observation whose provenance/content won. The
  // capture path stays a path even when the grouping identity is a git key.
  const projectPath =
    newestMember.projectPath ?? existingIdentity?.projectPath;
  const projectKey = newestMember.projectKey ?? existingIdentity?.projectKey;
  const captureCwd =
    newest.provenance?.cwd ??
    newestMember.captureCwd ??
    existingIdentity?.captureCwd;
  const lifecycleFields = existing
    ? memoryLifecycleMetadata(existing)
    : initializeMemoryLifecycle(
        newest.provenance?.capturedAt ?? newest.timestamp ?? nowIso,
        "distilled memory created",
        newest.agentId,
      );

  const memory: Memory = {
    ...lifecycleFields,
    id: memId,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    type: memoryTypeFor(newest),
    title,
    content: contentFor(newest, title),
    facts,
    concepts,
    files,
    sessionIds,
    strength,
    version: (existing?.version ?? 0) + 1,
    supersedes,
    sourceObservationIds,
    claimFingerprint: identity.claimFingerprint,
    evidenceFingerprint: identity.evidenceFingerprint,
    isLatest: existing?.isLatest !== false,
    ...(newest.subtitle !== undefined
      ? { subtitle: normalizeClaimText(newest.subtitle) }
      : {}),
    ...(newest.confidence !== undefined && Number.isFinite(newest.confidence)
      ? { confidence: newest.confidence }
      : {}),
    ...(newest.imageRef !== undefined ? { imageRef: newest.imageRef } : {}),
    ...(newest.imageData !== undefined ? { imageData: newest.imageData } : {}),
    ...(newest.imageDescription !== undefined
      ? { imageDescription: normalizeClaimText(newest.imageDescription) }
      : {}),
    ...(newest.modality !== undefined ? { modality: newest.modality } : {}),
    ...(newest.agentId !== undefined ? { agentId: newest.agentId } : {}),
    ...(existing?.parentId !== undefined ? { parentId: existing.parentId } : {}),
    ...(existing?.relatedIds !== undefined
      ? { relatedIds: existing.relatedIds }
      : {}),
    ...(existing?.forgetAfter !== undefined
      ? { forgetAfter: existing.forgetAfter }
      : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(projectKey ? { projectKey } : {}),
    ...(captureCwd ? { captureCwd } : {}),
    // Equivalent members have identical trust-relevant provenance. Carry the
    // newest one verbatim so capturedAt remains useful without synthesizing or
    // merging hashes across trust boundaries.
    ...(newest.provenance !== undefined
      ? { provenance: newest.provenance }
      : {}),
  };

  try {
    // StateKV.set is the successor installation point. It is atomic in both
    // stores; no source is touched until this resolves successfully.
    await kv.set(KV.memories, memId, memory);
  } catch (err) {
    logger.warn("distill: failed to write memory", {
      memId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Refresh the live indexes for the memory (remove-then-add so a re-run
  // replaces the prior version rather than duplicating it). If derived-state
  // refresh unexpectedly fails, keep every source and retry the whole handoff.
  try {
    idx.remove(memId);
    vectorIndexRemove(memId);
    if (isMemoryRecallable(memory)) {
      idx.add(memoryToObservation(memory));
      await vectorIndexAddGuarded(
        memId,
        memory.sessionIds[0] ?? "memory",
        [memory.title, memory.subtitle, memory.content, ...(memory.facts ?? [])]
          .filter(
            (part): part is string =>
              typeof part === "string" && part.length > 0,
          )
          .join(" "),
        { kind: "memory", logId: memId },
      );
    }
  } catch (err) {
    logger.warn("distill: failed to index successor memory", {
      memId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Prune the source observations in lockstep with every index.
  let folded = 0;
  for (const m of members) {
    try {
      await kv.delete(KV.observations(m.sessionId), m.obs.id);
      idx.remove(m.obs.id);
      vectorIndexRemove(m.obs.id);
      await deleteAccessLog(kv, m.obs.id);
      folded++;
    } catch (err) {
      logger.warn("distill: failed to prune observation", {
        obsId: m.obs.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Retention bookkeeping: records how reinforced this one claim is and when
  // it last consolidated, so a retention policy has a real score to act on.
  try {
    await kv.set(KV.retentionScores, memId, {
      memoryId: memId,
      strength,
      folded: sourceObservationIds.length,
      version: memory.version,
      lastConsolidated: nowIso,
    });
  } catch {
    // best-effort: retention scoring must never fail the sweep
  }

  return { memId, folded };
}

export function registerConsolidateFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::consolidate-pipeline",
    async (
      data?: { now?: number },
    ): Promise<{
      scannedGroups: number;
      consolidated: number;
      folded: number;
      protectedKept: number;
    }> => {
      const now = typeof data?.now === "number" ? data.now : Date.now();
      const floor = importanceFloor();
      const threshold = minGroup();

      let sessions: Session[];
      try {
        sessions = await kv.list<Session>(KV.sessions);
      } catch {
        return { scannedGroups: 0, consolidated: 0, folded: 0, protectedKept: 0 };
      }

      // 1. Bucket file-backed observations by (project, primary file).
      const groups = new Map<string, Grouped>();
      for (const session of sessions) {
        let observations: CompressedObservation[];
        try {
          observations = await kv.list<CompressedObservation>(
            KV.observations(session.id),
          );
        } catch {
          continue;
        }
        const identity = sessionProjectIdentity(session);
        // Stable key first, including one derived now for a legacy Session
        // that predates projectKey. It is an identity token only; the split
        // path/key fields travel on each member for storage and verification.
        const identityKey =
          identity.projectKey ||
          identity.projectPath ||
          identity.captureCwd ||
          "_";
        for (const obs of observations) {
          if (!CONSOLIDATABLE_TYPES.has(obs.type)) continue;
          const files = obs.provenance?.files ?? obs.files;
          const primaryFile = files?.find((f) => f && f.trim());
          if (!primaryFile) continue;
          // A serialized tuple is unambiguous even for unusual but legal Unix
          // paths containing newlines.
          const key = JSON.stringify([identityKey, primaryFile]);
          let g = groups.get(key);
          if (!g) {
            g = { identityKey, primaryFile, members: [] };
            groups.set(key, g);
          }
          g.members.push({ sessionId: session.id, obs, ...identity });
        }
      }

      let consolidated = 0;
      let folded = 0;
      let protectedKept = 0;

      // 2. Partition each file bucket by deterministic claim + evidence
      // identity. The minimum applies to a TRUE-DUPLICATE partition, never to
      // the file bucket as a whole.
      for (const g of groups.values()) {
        // Protect important / user-confirmed / ever-accessed observations:
        // never fold or delete them. They stay as first-class observations.
        const foldable: DistillMember[] = [];
        for (const m of g.members) {
          const imp = m.obs.importance;
          const isImportant = !Number.isFinite(imp) || imp > floor;
          const isConfirmed = m.obs.provenance?.userConfirmed === true;
          let accessed = false;
          try {
            accessed = (await getAccessLog(kv, m.obs.id)).count > 0;
          } catch {
            accessed = false; // access log unavailable -> treat as not accessed
          }
          if (isImportant || isConfirmed || accessed) {
            protectedKept++;
            continue;
          }
          foldable.push(m);
        }

        if (foldable.length < threshold) continue; // no duplicate set can qualify

        const equivalent = new Map<string, DistillMember[]>();
        for (const member of foldable) {
          const key = observationIdentity(member.obs).key;
          const claimGroup = equivalent.get(key);
          if (claimGroup) claimGroup.push(member);
          else equivalent.set(key, [member]);
        }

        for (const claimGroup of equivalent.values()) {
          if (claimGroup.length < threshold) continue;
          const r = await distillMembers(kv, {
            projectIdentity: g.identityKey,
            primaryFile: g.primaryFile,
            members: claimGroup,
            now,
          });
          if (!r) continue;
          folded += r.folded;
          consolidated++;
        }
      }

      if (consolidated > 0) {
        logger.info("consolidate: distilled observations into memories", {
          scannedGroups: groups.size,
          consolidated,
          folded,
          protectedKept,
        });
      }
      return {
        scannedGroups: groups.size,
        consolidated,
        folded,
        protectedKept,
      };
    },
  );
}
