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

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { CompressedObservation, Memory, Session } from "./types.js";
import { KV } from "../state/schema.js";
import { isUnsourced } from "./provenance.js";
import { memoryToObservation } from "./memory-utils.js";
import { logger } from "./logger.js";

export interface DoctorEntry {
  id: string;
  title: string;
  reason: string;
}
export interface DoctorReport {
  total: number;
  safe: number;
  stale: DoctorEntry[];
  unsourced: DoctorEntry[];
}

function missingFiles(files: string[] | undefined, root: string): string[] {
  if (!files || files.length === 0) return [];
  return files.filter((f) => {
    const abs = isAbsolute(f) ? f : resolve(root, f);
    return !existsSync(abs);
  });
}

/** Audit one observation against the repo root. */
function auditOne(
  obs: CompressedObservation,
  root: string,
): { kind: "safe" | "stale" | "unsourced"; entry: DoctorEntry } {
  const prov = obs.provenance;
  if (isUnsourced(prov)) {
    return {
      kind: "unsourced",
      entry: { id: obs.id, title: obs.title, reason: "no file, command, or user-confirmation evidence" },
    };
  }
  const gone = missingFiles(prov?.files, root);
  if (gone.length > 0) {
    return {
      kind: "stale",
      entry: {
        id: obs.id,
        title: obs.title,
        reason: `references ${gone.length} file(s) that no longer exist: ${gone.slice(0, 3).join(", ")}`,
      },
    };
  }
  return { kind: "safe", entry: { id: obs.id, title: obs.title, reason: "" } };
}

export function registerDoctorFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::doctor",
    async (data: { root?: string; project?: string }): Promise<DoctorReport> => {
      const root = data?.root ?? process.cwd();
      const report: DoctorReport = { total: 0, safe: 0, stale: [], unsourced: [] };

      const audit = (obs: CompressedObservation) => {
        report.total++;
        const { kind, entry } = auditOne(obs, root);
        if (kind === "safe") report.safe++;
        else if (kind === "stale") report.stale.push(entry);
        else report.unsourced.push(entry);
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
