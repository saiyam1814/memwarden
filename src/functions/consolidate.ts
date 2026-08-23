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
// This sweep groups file-backed observations by (project, primary file),
// distills each group into ONE canonical Memory, and prunes the folded source
// observations in lockstep with the search + vector indexes (the same
// discipline mem::auto-forget uses). N near-identical observations about a file
// collapse to 1 memory, which:
//   - populates KV.memories so /stats and doctor stop reporting a phantom layer
//   - bounds storage growth (the folded rows are removed)
//   - fixes correlated rot: a drifted file yields 1 stale memory, not 113
//   - stops recall competing against dozens of near-duplicates for one file
//
// Firewall safety: the memory inherits the NEWEST observation's provenance
// verbatim (files + capture-time fileHashes). Verified Recall therefore
// re-checks it against the live file exactly as that observation would — a
// consolidated memory can only be `verified`/`sourced`/`stale` for the same
// reasons its newest source was. Adopted (hashless) observations stay hashless,
// so they can never be laundered into `verified`.
//
// Conservative by construction: observations that are important (importance
// above the floor), user-confirmed, or ever-accessed are NEVER folded or
// deleted. Groups smaller than the minimum are left untouched. Non-file
// observations (conversations, prompts) are never consolidated.
//
// Tuning (env): MEMWARDEN_CONSOLIDATE_MIN_GROUP (default 3),
// MEMWARDEN_CONSOLIDATE_IMPORTANCE_FLOOR (default 5; above is protected).
// Cadence + on/off live in the boot timers (CONSOLIDATION_*).

import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { CompressedObservation, Memory, Session } from "./types.js";
import { KV, fingerprintId } from "../state/schema.js";
import {
  getSearchIndex,
  vectorIndexRemove,
  vectorIndexAddGuarded,
} from "./search.js";
import { memoryToObservation } from "./memory-utils.js";
import { getAccessLog, deleteAccessLog } from "./access-tracker.js";
import { logger } from "./logger.js";

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
    return ov >= bv ? o : best;
  });
}

function unique(values: Iterable<string>): string[] {
  return Array.from(new Set(values));
}

interface Grouped {
  key: string;
  project: string;
  primaryFile: string;
  members: Array<{ sessionId: string; obs: CompressedObservation }>;
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
      const nowIso = new Date(now).toISOString();
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
        const project = session.projectKey || session.project || "_";
        for (const obs of observations) {
          if (!CONSOLIDATABLE_TYPES.has(obs.type)) continue;
          const files = obs.provenance?.files ?? obs.files;
          const primaryFile = files?.find((f) => f && f.trim());
          if (!primaryFile) continue;
          // Newline delimiter: cannot appear in a project key or a file path,
          // so (project, file) can never ambiguously collide.
          const key = `${project}\n${primaryFile}`;
          let g = groups.get(key);
          if (!g) {
            g = { key, project, primaryFile, members: [] };
            groups.set(key, g);
          }
          g.members.push({ sessionId: session.id, obs });
        }
      }

      const idx = getSearchIndex();
      let consolidated = 0;
      let folded = 0;
      let protectedKept = 0;

      // 2. Distill each qualifying group into one canonical Memory.
      for (const g of groups.values()) {
        // Protect important / user-confirmed / ever-accessed observations:
        // never fold or delete them. They stay as first-class observations.
        const foldable: Array<{ sessionId: string; obs: CompressedObservation }> =
          [];
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

        if (foldable.length < threshold) continue; // not worth collapsing

        const groupObs = foldable.map((m) => m.obs);
        const newest = newestOf(groupObs);

        const memId = fingerprintId("mem", g.key);
        const existing = await kv
          .get<Memory>(KV.memories, memId)
          .catch(() => null);

        const concepts = unique(groupObs.flatMap((o) => o.concepts ?? [])).slice(
          0,
          24,
        );
        const files = unique([
          g.primaryFile,
          ...(newest.provenance?.files ?? newest.files ?? []),
        ]);
        const sessionIds = unique(foldable.map((m) => m.sessionId));
        const sourceObservationIds = groupObs.map((o) => o.id);
        // Strength climbs with reinforcement (how many times the file was
        // touched), capped at the 1-10 scale.
        const strength = Math.min(
          10,
          5 + Math.floor(Math.log2(Math.max(2, foldable.length))),
        );

        const memory: Memory = {
          id: memId,
          createdAt: existing?.createdAt ?? nowIso,
          updatedAt: nowIso,
          type: memoryTypeFor(newest),
          title: newest.title || `Knowledge about ${g.primaryFile}`,
          content: newest.narrative || (newest.facts ?? []).join(" "),
          concepts,
          files,
          sessionIds,
          strength,
          version: (existing?.version ?? 0) + 1,
          supersedes: sourceObservationIds,
          sourceObservationIds,
          isLatest: true,
          ...(g.project !== "_" ? { project: g.project } : {}),
          // Carry the newest observation's provenance forward VERBATIM so the
          // memory verifies against the live file exactly as that observation
          // would. No synthetic hashes are ever invented.
          ...(newest.provenance ? { provenance: newest.provenance } : {}),
        };

        try {
          await kv.set(KV.memories, memId, memory);
        } catch (err) {
          logger.warn("consolidate: failed to write memory", {
            memId,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        // Refresh the live indexes for the memory (remove-then-add so a
        // re-run replaces the prior version rather than duplicating it).
        idx.remove(memId);
        idx.add(memoryToObservation(memory));
        vectorIndexRemove(memId);
        await vectorIndexAddGuarded(
          memId,
          memory.sessionIds[0] ?? "memory",
          memory.title + " " + memory.content,
          { kind: "memory", logId: memId },
        );

        // Prune the folded source observations in lockstep with every index,
        // same discipline as mem::auto-forget.
        for (const m of foldable) {
          try {
            await kv.delete(KV.observations(m.sessionId), m.obs.id);
            idx.remove(m.obs.id);
            vectorIndexRemove(m.obs.id);
            await deleteAccessLog(kv, m.obs.id);
            folded++;
          } catch (err) {
            logger.warn("consolidate: failed to prune observation", {
              obsId: m.obs.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Retention bookkeeping (the previously-dead KV.retentionScores):
        // records how reinforced this memory is and when it last consolidated,
        // so a later retention policy has a real score to act on.
        try {
          await kv.set(KV.retentionScores, memId, {
            memoryId: memId,
            strength,
            folded: foldable.length,
            version: memory.version,
            lastConsolidated: nowIso,
          });
        } catch {
          // best-effort: retention scoring must never fail the sweep
        }

        consolidated++;
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
