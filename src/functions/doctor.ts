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
import type { CompressedObservation, Memory, Session } from "./types.js";
import { KV } from "../state/schema.js";
import { classifyProvenance } from "./verify.js";
import { memoryToObservation } from "./memory-utils.js";
import { canonicalizePath } from "./paths.js";
import { getDataDir } from "./config.js";
import { logger } from "./logger.js";
import { detectConflicts, type MemoryConflict } from "./conflicts.js";

/** Recursive size of a directory in bytes; 0 when it doesn't exist. */
function dirSizeBytes(dir: string): number {
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
  reason: string;
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
  safe: number; // verified + sourcedUnverified (everything injectable)
  verified: number; // code-backed and current
  sourcedUnverified: number; // sourced but not content-verified
  stale: DoctorEntry[];
  unsourced: DoctorEntry[];
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
        conflicts: [],
        footprint: { bytesOnDisk: 0, dataDir: getDataDir(), oplogEntries: 0 },
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
