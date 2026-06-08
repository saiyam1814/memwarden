//
// mem::doctor — the memory doctor / firewall. Audits stored memories for
// trustworthiness against the live repo, not just integrity:
//
//   STALE      a memory references files that no longer exist under the root
//   UNSOURCED  a memory has no evidence (no files, no command, not confirmed)
//   SAFE       sourced and still valid -> safe to inject
//
// File checks run in the daemon (same machine as the repo). Conflict
// detection (memories that disagree) is a documented next step — we don't
// ship a fuzzy heuristic in a tool whose whole point is trust.

import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { CompressedObservation, Memory, Session } from "./types.js";
import { KV } from "../state/schema.js";
import { classifyProvenance } from "./verify.js";
import { memoryToObservation } from "./memory-utils.js";
import { logger } from "./logger.js";

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
}

export function registerDoctorFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::doctor",
    async (data: { root?: string; project?: string }): Promise<DoctorReport> => {
      const root = data?.root ?? process.cwd();
      const report: DoctorReport = {
        total: 0,
        safe: 0,
        verified: 0,
        sourcedUnverified: 0,
        stale: [],
        unsourced: [],
      };

      const audit = (obs: CompressedObservation) => {
        report.total++;
        const verdict = classifyProvenance(obs.provenance, root);
        const entry: DoctorEntry = { id: obs.id, title: obs.title, reason: verdict.reason };
        switch (verdict.status) {
          case "verified":
            report.verified++;
            report.safe++;
            break;
          case "sourced_unverified":
            report.sourcedUnverified++;
            report.safe++;
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
          if (data?.project && m.project && m.project !== data.project) continue;
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
        if (data?.project && s.project && s.project !== data.project) continue;
        const obs = await kv
          .list<CompressedObservation>(KV.observations(s.id))
          .catch(() => []);
        for (const o of obs) audit(o);
      }

      return report;
    },
  );
}
