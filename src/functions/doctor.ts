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

import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { CompressedObservation, Memory, Session } from "./types.js";
import { KV } from "../state/schema.js";
import { classifyProvenance } from "./verify.js";
import { memoryToObservation } from "./memory-utils.js";
import { canonicalizePath } from "./paths.js";
import { logger } from "./logger.js";
import { detectConflicts, type MemoryConflict } from "./conflicts.js";

export interface DoctorEntry {
  id: string;
  title: string;
  reason: string;
}
export interface DoctorReport {
  total: number;
  safe: number; // verified + sourcedUnverified (everything injectable)
  verified: number; // code-backed and current
  sourcedUnverified: number; // sourced but not content-verified
  stale: DoctorEntry[];
  unsourced: DoctorEntry[];
  conflicts: MemoryConflict[];
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
        conflicts: [],
      };
      const conflictCandidates: CompressedObservation[] = [];

      const audit = (obs: CompressedObservation) => {
        report.total++;
        const verdict = classifyProvenance(obs.provenance, root);
        const entry: DoctorEntry = { id: obs.id, title: obs.title, reason: verdict.reason };
        switch (verdict.status) {
          case "verified":
            report.verified++;
            report.safe++;
            conflictCandidates.push(obs);
            break;
          case "sourced_unverified":
            report.sourcedUnverified++;
            report.safe++;
            conflictCandidates.push(obs);
            break;
          case "stale":
            report.stale.push(entry);
            break;
          default:
            report.unsourced.push(entry);
        }
      };

      // Memories (mem::remember scope).
      try {
        const memories = await kv.list<Memory>(KV.memories);
        for (const m of memories) {
          if (m.isLatest === false) continue;
          if (
            projectFilter &&
            m.project &&
            canonicalizePath(m.project) !== projectFilter
          )
            continue;
          audit(memoryToObservation(m));
        }
      } catch (err) {
        logger.warn("doctor: failed to load memories", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Per-session observations, optionally scoped by project/cwd.
      const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
      for (const s of sessions) {
        if (
          projectFilter &&
          s.project &&
          canonicalizePath(s.project) !== projectFilter
        )
          continue;
        const obs = await kv
          .list<CompressedObservation>(KV.observations(s.id))
          .catch(() => []);
        for (const o of obs) audit(o);
      }

      report.conflicts = detectConflicts(conflictCandidates);
      return report;
    },
  );
}
