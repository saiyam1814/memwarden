//
// mem::auto-forget — retention sweep. Without it the store grows without
// bound and recall slows as it fills with stale, never-touched entries.
//
// An observation is forgotten when ALL hold: it is older than the TTL, has
// never been accessed, and its importance is at or below the floor — which
// defaults to the capture default (5), so ORDINARY observations genuinely
// age out. Explicitly-important records (importance > 5, e.g. user prompts
// at 6) and anything ever accessed are always kept, as are records with a
// missing/unparseable importance or timestamp (never forget on bad data).
// Forgetting removes the record from KV, the BM25 index, the vector index,
// and its access log in lockstep so they stay consistent.
//
// Tuning (env): MEMWARDEN_FORGET_TTL_DAYS (default 30),
// MEMWARDEN_FORGET_IMPORTANCE_FLOOR (default 5; at-or-below is sweepable).
// The sweep cadence and on/off live in the boot timers (AUTO_FORGET_*).

import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { CompressedObservation, Session } from "./types.js";
import { KV } from "../state/schema.js";
import { getSearchIndex, vectorIndexRemove } from "./search.js";
import { getAccessLog, deleteAccessLog } from "./access-tracker.js";
import { logger } from "./logger.js";

function ttlMs(): number {
  const days = parseInt(process.env.MEMWARDEN_FORGET_TTL_DAYS ?? "30", 10);
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
}

function importanceFloor(): number {
  // Importance is on the observation's 1-10 scale (capture defaults to 5).
  // Records AT or below the floor are sweepable. The floor must therefore
  // sit at the capture default: the old floor of 3 (with a strict <) kept
  // every ordinary importance-5 observation forever — retention theater —
  // while long-lived MCP/proxy sessions marched toward the per-session
  // observation ceiling. With 5, ordinary old never-accessed records age
  // out; explicitly-important ones (6+, e.g. user prompts) are kept.
  const raw = parseFloat(process.env.MEMWARDEN_FORGET_IMPORTANCE_FLOOR ?? "5");
  return Number.isFinite(raw) ? raw : 5;
}

export function registerForgetFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::auto-forget",
    async (data?: { now?: number }): Promise<{ scanned: number; forgotten: number }> => {
      const now = typeof data?.now === "number" ? data.now : Date.now();
      const cutoff = now - ttlMs();
      const floor = importanceFloor();
      let scanned = 0;
      let forgotten = 0;

      let sessions: Session[];
      try {
        sessions = await kv.list<Session>(KV.sessions);
      } catch {
        return { scanned: 0, forgotten: 0 };
      }

      const idx = getSearchIndex();
      for (const session of sessions) {
        let observations: CompressedObservation[];
        try {
          observations = await kv.list<CompressedObservation>(
            KV.observations(session.id),
          );
        } catch {
          continue;
        }
        for (const obs of observations) {
          scanned++;
          const ts = new Date(obs.timestamp).getTime();
          // Keep if newer than the cutoff, or if the timestamp is unparseable
          // (never forget on bad data).
          if (Number.isNaN(ts) || ts > cutoff) continue;
          // Keep when importance is above the floor OR missing/NaN. A record
          // with no importance must not be treated as low-importance and
          // swept — the intent is "explicitly-important always kept", and
          // `undefined > floor` / `NaN > floor` are both false, which would
          // wrongly delete it. At-or-below the floor (ordinary records) is
          // sweepable.
          if (!Number.isFinite(obs.importance) || obs.importance > floor) continue;
          const access = await getAccessLog(kv, obs.id);
          if (access.count > 0) continue;

          // Forget: remove from every index in lockstep.
          try {
            await kv.delete(KV.observations(session.id), obs.id);
            idx.remove(obs.id);
            vectorIndexRemove(obs.id);
            await deleteAccessLog(kv, obs.id);
            forgotten++;
          } catch (err) {
            logger.warn("auto-forget: failed to remove observation", {
              obsId: obs.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      // cutoff is logged for observability of the retention window.
      if (forgotten > 0) {
        logger.info("auto-forget swept stale memories", {
          scanned,
          forgotten,
          cutoff: new Date(cutoff).toISOString(),
        });
      }
      return { scanned, forgotten };
    },
  );
}
