//
// mem::auto-forget — retention sweep. Without it the store grows without
// bound and recall slows as it fills with stale, never-touched entries.
//
// THE DURABILITY CONTRACT: code-backed knowledge is DISTILLED, never dropped.
//
// This sweep used to delete every expiring observation outright, with no check
// that anything durable had been distilled from it first. Measured on a real
// install: 15,771 observations captured, **0 memories**, and the sweep quietly
// removing hundreds of code-backed rows per hour at the TTL. Capture worked,
// consolidation only folded groups of 3+ touches of the same file, and
// everything else aged out — so the layer was a sieve, and the one thing a
// memory product must never do is exactly what it did.
//
// Now, at the TTL:
//   - an observation carrying FILE PROVENANCE is promoted into a Memory
//     (distillMembers, the same primitive mem::consolidate-pipeline uses), so
//     its knowledge and its capture-time file hashes survive as one compact,
//     verifiable row. Storage still shrinks — the raw row is pruned and repeat
//     touches of a file converge on a single memory id — but nothing
//     code-backed is lost.
//   - an observation with NO provenance at all (no files to verify against) is
//     deleted as before. There is nothing durable to promote, and keeping
//     unsourced text forever is how a memory layer rots.
//
// It also makes sweep-vs-consolidate ORDERING irrelevant: whichever timer fires
// first, code-backed knowledge ends up distilled rather than raced into oblivion.
//
// An observation is eligible for the TTL path when ALL hold: it is older than
// the TTL, has never been accessed, and its importance is at or below the floor
// — which defaults to the capture default (5), so ORDINARY observations age
// out. Explicitly-important records (importance > 5, e.g. user prompts at 6)
// and anything ever accessed are always kept untouched, as are records with a
// missing/unparseable importance or timestamp (never act on bad data).
//
// Tuning (env): MEMWARDEN_FORGET_TTL_DAYS (default 30),
// MEMWARDEN_FORGET_IMPORTANCE_FLOOR (default 5; at-or-below is sweepable),
// MEMWARDEN_FORGET_PROMOTE=off to restore delete-only behavior.
// The sweep cadence and on/off live in the boot timers (AUTO_FORGET_*).

import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { CompressedObservation, Session } from "./types.js";
import { KV } from "../state/schema.js";
import { getSearchIndex, vectorIndexRemove } from "./search.js";
import { getAccessLog, deleteAccessLog } from "./access-tracker.js";
import { distillMembers } from "./consolidate.js";
import { sessionProjectIdentity } from "./memory-identity.js";
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

/** Distilling on expiry is the default; set MEMWARDEN_FORGET_PROMOTE=off to go
 *  back to deleting expiring code-backed observations outright. */
function promoteEnabled(): boolean {
  return (process.env.MEMWARDEN_FORGET_PROMOTE ?? "").toLowerCase() !== "off";
}

export function registerForgetFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::auto-forget",
    async (
      data?: { now?: number },
    ): Promise<{ scanned: number; forgotten: number; promoted: number }> => {
      const now = typeof data?.now === "number" ? data.now : Date.now();
      const cutoff = now - ttlMs();
      const floor = importanceFloor();
      const promote = promoteEnabled();
      let scanned = 0;
      let forgotten = 0;
      let promoted = 0;

      let sessions: Session[];
      try {
        sessions = await kv.list<Session>(KV.sessions);
      } catch {
        return { scanned: 0, forgotten: 0, promoted: 0 };
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

          // Code-backed? Distill instead of delete (the durability contract).
          // distillMembers writes/reinforces the memory, refreshes both indexes
          // and prunes this raw row — so on success there is nothing left to
          // delete here. On failure it prunes NOTHING, and we deliberately keep
          // the observation rather than lose knowledge to a transient error;
          // the next sweep retries.
          const provFiles = obs.provenance?.files ?? obs.files;
          const primaryFile = provFiles?.find((f) => f && f.trim());
          if (promote && primaryFile) {
            const identity = sessionProjectIdentity(session);
            const projectIdentity =
              identity.projectKey ||
              identity.projectPath ||
              identity.captureCwd ||
              "_";
            const r = await distillMembers(kv, {
              projectIdentity,
              primaryFile,
              members: [{ sessionId: session.id, obs, ...identity }],
              now,
            });
            if (r) promoted++;
            continue;
          }

          // No provenance to verify against: nothing durable to promote, so
          // remove from every index in lockstep.
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
      if (forgotten > 0 || promoted > 0) {
        logger.info("auto-forget: retention sweep", {
          scanned,
          promoted,
          forgotten,
          cutoff: new Date(cutoff).toISOString(),
        });
      }
      return { scanned, forgotten, promoted };
    },
  );
}
