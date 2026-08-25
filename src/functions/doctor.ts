//
// mem::doctor — the memory doctor / firewall. Audits stored memories for
// trustworthiness against the live repo, not just integrity:
//
//   VERIFIED   code-backed memory still matches its capture-time hashes
//   SOURCED    sourced, but not content-verified
//   STALE      references files that no longer exist or changed under root
//   UNSOURCED  no evidence (no files, no command, not confirmed)
//   CONFLICTS  newer sourced memories that contradict older sourced memories
//
// File checks run in the daemon (same machine as the repo). Conflict detection
// is intentionally conservative and explainable: simple subject/value claims,
// no LLM, no fuzzy black box.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type {
  CompressedObservation,
  Memory,
  MemoryLifecycleState,
  Session,
} from "./types.js";
import { KV } from "../state/schema.js";
import {
  classifyProvenance,
  type EvidenceTrust,
  type LiveSourceStatus,
} from "./verify.js";
import { memoryToObservation } from "./memory-utils.js";
import {
  lifecycleProjection,
  validityIntervalsOf,
} from "./memory-lifecycle.js";
import {
  hasProjectIdentity,
  projectIdentityMatchesPath,
  resolveMemoryIdentity,
  sessionProjectIdentity,
  type ProjectIdentity,
} from "./memory-identity.js";
import { canonicalizePath } from "./paths.js";
import { getDataDir } from "./config.js";
import { logger } from "./logger.js";
import { detectConflicts, type MemoryConflict } from "./conflicts.js";
import type { FineGrainedAnchorStatus } from "./anchors.js";

/** Recursive size of a directory in bytes; 0 when it doesn't exist. */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(p);
      else if (e.isFile()) total += statSync(p).size;
    } catch {
      // racing deletes are fine — best-effort
    }
  }
  return total;
}

export interface DoctorEntry {
  id: string;
  title: string;
  /** Compatibility summary (the old four-state verdict reason). */
  reason: string;
  evidenceVerdict: EvidenceTrust;
  evidenceReason: string;
  sourceStatus: LiveSourceStatus;
  sourceReason: string;
  fineGrainedAnchorStatus?: FineGrainedAnchorStatus;
  fineGrainedAnchorActionable?: boolean;
  persistedLifecycle: MemoryLifecycleState;
  effectiveLifecycle: MemoryLifecycleState;
  /** The last explicit semantic decision, never replaced by drift text. */
  transitionReason: string;
  lifecycleReason: string;
  observedAt: string;
  validFrom?: string;
  validTo?: string;
  validityReconstruction: "recorded" | "legacy_inferred" | "unavailable";
  sourceCommit?: string;
  attestation?: "canon-imported" | "canon-reanchored";
}
export interface DoctorFootprint {
  /** Total bytes the brain occupies on disk (whole data dir). */
  bytesOnDisk: number;
  /** Where it lives. */
  dataDir: string;
  /** Append-only oplog length — growth observability. */
  oplogEntries: number;
}
export interface DoctorReport {
  total: number;
  safe: number; // compatibility: current verified + sourced_unverified
  verified: number; // compatibility: legacy verified verdict
  sourcedUnverified: number; // compatibility: legacy sourced verdict
  stale: DoctorEntry[];
  unsourced: DoctorEntry[];
  entries: DoctorEntry[];
  evidence: Record<EvidenceTrust, number>;
  source: Record<LiveSourceStatus, number>;
  lifecycle: Record<MemoryLifecycleState, DoctorEntry[]>;
  conflicts: MemoryConflict[];
  /** Disk/size honesty: memory layers that hide their footprint end up
   * surprising users with gigabytes. memwarden reports it on every audit. */
  footprint: DoctorFootprint;
}

export function registerDoctorFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::doctor",
    async (data: { root?: string; project?: string }): Promise<DoctorReport> => {
      const root = data?.root ?? process.cwd();
      // Project scope is canonicalized the same way search scopes recall, so
      // /tmp vs /private/tmp (and trailing-slash/`..` spellings) of the same
      // directory match. undefined => whole-brain audit across every project.
      const projectFilter =
        typeof data?.project === "string" && data.project.trim().length > 0
          ? canonicalizePath(data.project)
          : undefined;
      const report: DoctorReport = {
        total: 0,
        safe: 0,
        verified: 0,
        sourcedUnverified: 0,
        stale: [],
        unsourced: [],
        entries: [],
        evidence: { verified: 0, sourced: 0, unsourced: 0 },
        source: {
          matched: 0,
          cosmetic_drift: 0,
          drifted: 0,
          missing: 0,
          unknown: 0,
        },
        lifecycle: {
          active: [],
          needs_revalidation: [],
          superseded: [],
          disputed: [],
          archived: [],
          revoked: [],
        },
        conflicts: [],
        footprint: { bytesOnDisk: 0, dataDir: getDataDir(), oplogEntries: 0 },
      };
      const conflictCandidates: CompressedObservation[] = [];

      // Resolve sessions once: distilled Memory rows live outside session
      // scopes, but their source session is the compatibility bridge for rows
      // written before projectPath/projectKey existed.
      const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
      const sessionsById = new Map(sessions.map((session) => [session.id, session]));
      const inScope = (identity: ProjectIdentity): boolean =>
        !projectFilter ||
        (hasProjectIdentity(identity) &&
          projectIdentityMatchesPath(identity, projectFilter));
      const audit = (
        obs: CompressedObservation,
        identity: ProjectIdentity,
        memory: Memory | null = null,
      ) => {
        report.total++;
        // A stable-key match may widen which memory is audited, but the value
        // passed to the verifier is always `root`, the caller's real checkout.
        const verdict = classifyProvenance(obs.provenance, root, {
          verifyAgainstRoot: projectIdentityMatchesPath(identity, root),
        });
        const projection = lifecycleProjection(
          memory,
          verdict.sourceStatus,
          verdict.evidenceTrust === "verified" && verdict.sourceStatus === "unknown",
        );
        const intervals = memory ? validityIntervalsOf(memory) : [];
        const latest = intervals[intervals.length - 1];
        const observedAt =
          memory?.observedAt ?? obs.provenance?.capturedAt ?? obs.timestamp;
        const canon = obs.provenance?.canon;
        const entry: DoctorEntry = {
          id: obs.id,
          title: obs.title,
          reason: verdict.reason,
          evidenceVerdict: verdict.evidenceTrust,
          evidenceReason: verdict.evidenceReason,
          sourceStatus: verdict.sourceStatus,
          sourceReason: verdict.sourceReason,
          ...(verdict.fineGrained
            ? {
                fineGrainedAnchorStatus: verdict.fineGrained.status,
                fineGrainedAnchorActionable: verdict.fineGrained.actionable,
              }
            : {}),
          persistedLifecycle: projection.persisted,
          effectiveLifecycle: projection.effective,
          transitionReason: projection.persistedReason,
          lifecycleReason: projection.effectiveReason,
          observedAt,
          ...(latest?.validFrom
            ? { validFrom: latest.validFrom }
            : { validFrom: observedAt }),
          ...(latest?.validTo ? { validTo: latest.validTo } : {}),
          validityReconstruction: memory
            ? intervals.length === 0
              ? "unavailable"
              : intervals.some((interval) => interval.inferred)
                ? "legacy_inferred"
                : "recorded"
            : "unavailable",
          ...(memory?.sourceCommit ? { sourceCommit: memory.sourceCommit } : {}),
          ...(canon
            ? {
                attestation: canon.reanchoredAt
                  ? ("canon-reanchored" as const)
                  : ("canon-imported" as const),
              }
            : {}),
        };
        report.entries.push(entry);
        report.evidence[verdict.evidenceTrust]++;
        report.source[verdict.sourceStatus]++;
        report.lifecycle[projection.effective].push(entry);
        switch (verdict.status) {
          case "verified":
            report.verified++;
            if (projection.effective === "active") {
              report.safe++;
              conflictCandidates.push(obs);
            }
            break;
          case "sourced_unverified":
            report.sourcedUnverified++;
            if (projection.effective === "active") {
              report.safe++;
              conflictCandidates.push(obs);
            }
            break;
          case "stale":
            report.stale.push(entry);
            break;
          default:
            report.unsourced.push(entry);
        }
      };

      // Memories (distilled / imported scope).
      try {
        const memories = await kv.list<Memory>(KV.memories);
        for (const memory of memories) {
          const identity = resolveMemoryIdentity(memory, sessionsById);
          if (!inScope(identity)) continue;
          audit(memoryToObservation(memory, identity), identity, memory);
        }
      } catch (err) {
        logger.warn("doctor: failed to load memories", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Per-session observations, optionally scoped by project/cwd with the
      // exact same path-or-stable-key predicate as distilled memories.
      for (const session of sessions) {
        const identity = sessionProjectIdentity(session);
        if (!inScope(identity)) continue;
        const obs = await kv
          .list<CompressedObservation>(KV.observations(session.id))
          .catch(() => []);
        for (const observation of obs) audit(observation, identity);
      }

      report.conflicts = detectConflicts(conflictCandidates);

      // Footprint: whole-data-dir size + oplog length. Best-effort — a
      // failure here must never sink the audit itself.
      try {
        const dataDir = getDataDir();
        const { count } = await sdk.trigger<
          Record<string, never>,
          { count: number }
        >({ function_id: "state::oplog-count", payload: {} });
        report.footprint = {
          bytesOnDisk: dirSizeBytes(dataDir),
          dataDir,
          oplogEntries: count,
        };
      } catch {
        // leave the zero footprint from initialization
      }
      return report;
    },
  );
}
