//
// mem::forget — user-initiated deletion with a RECEIPT. The pain this
// answers is real and documented across competitor trackers: deletes that
// return success while the data stays on disk, with no way to prove
// otherwise. memwarden's delete is verifiable two ways:
//
//   1. The observation is removed from KV and every index in lockstep, and
//      the response reports what was actually removed (deleted: false when
//      the id wasn't found — never a fake success).
//   2. The deletion lands in the hash-chained oplog like every mutation, so
//      the receipt cites the chain: the entry that recorded the delete, the
//      entry that recorded the original write, and whether the whole chain
//      verifies. Anyone with the store can recompute both hashes. Payloads
//      are never included — a receipt proves the delete without
//      re-disclosing what was deleted.
//
// The receipt's own hash covers its fields, so a receipt file can be
// checked for integrity on its own, offline.

import { createHash } from "node:crypto";
import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { CompressedObservation, Session } from "./types.js";
import { KV } from "../state/schema.js";
import { getSearchIndex, vectorIndexRemove } from "./search.js";
import { deleteAccessLog } from "./access-tracker.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { logger } from "./logger.js";

interface ChainEntry {
  id: number;
  ts: string;
  op: string;
  scope: string;
  key: string;
  hash: string;
  prev_hash: string;
}

export interface DeleteReceipt {
  obsId: string;
  title: string;
  deletedAt: string;
  /** The oplog entry that recorded this deletion. */
  deleteEntry: ChainEntry | null;
  /** The oplog entry that recorded the original write, when still present. */
  createEntry: ChainEntry | null;
  /** Whole-chain verification at receipt time. */
  chainIntact: boolean;
  /**
   * Honest scope of the deletion: forget removes the record from the active
   * store, search, recall, and every index — but the original content stays
   * inside the local append-only oplog (that is what makes the chain
   * tamper-evident). False until oplog compaction/erasure ships.
   */
  contentErased: false;
  /** SHA-256 over the canonical receipt fields above — offline-checkable. */
  receiptHash: string;
}

export interface ForgetResult {
  deleted: boolean;
  reason?: string;
  receipt?: DeleteReceipt;
}

function receiptHash(fields: Omit<DeleteReceipt, "receiptHash">): string {
  // Stable key order via explicit construction — this is the contract a
  // receipt verifier recomputes.
  const canonical = JSON.stringify({
    obsId: fields.obsId,
    title: fields.title,
    deletedAt: fields.deletedAt,
    deleteEntry: fields.deleteEntry,
    createEntry: fields.createEntry,
    chainIntact: fields.chainIntact,
    contentErased: fields.contentErased,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function registerReceiptFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::forget",
    async (data: { observationId?: string }): Promise<ForgetResult> => {
      const obsId = (data?.observationId ?? "").trim();
      if (!obsId) return { deleted: false, reason: "observationId is required" };

      // Find the session holding this observation (ids are globally unique;
      // storage is scoped per session).
      let sessions: Session[];
      try {
        sessions = await kv.list<Session>(KV.sessions);
      } catch {
        return { deleted: false, reason: "store unavailable" };
      }
      let found: { sessionId: string; obs: CompressedObservation } | undefined;
      for (const session of sessions) {
        const obs = await kv
          .get<CompressedObservation>(KV.observations(session.id), obsId)
          .catch(() => null);
        if (obs) {
          found = { sessionId: session.id, obs };
          break;
        }
      }
      if (!found) {
        // The honest failure: nothing pretended, nothing "succeeded".
        return { deleted: false, reason: `no observation with id ${obsId}` };
      }

      // Remove from KV and every index in lockstep, under the SAME per-session
      // lock mem::observe takes when it adds to those global indexes —
      // otherwise a concurrent observe could re-add this id to the BM25/vector
      // index after we removed it (a ghost that outlives the deleted record).
      await withKeyedLock(`obs:${found.sessionId}`, async () => {
        await kv.delete(KV.observations(found!.sessionId), obsId);
        getSearchIndex().remove(obsId);
        vectorIndexRemove(obsId);
        await deleteAccessLog(kv, obsId);
      });

      // Build the receipt from the chain — scoped to this observation's own
      // KV scope so a same-named key in another scope can't be mis-cited.
      const { entries } = await sdk.trigger<
        { key: string; scope: string },
        { entries: ChainEntry[] }
      >({
        function_id: "state::oplog-find",
        payload: { key: obsId, scope: KV.observations(found.sessionId) },
      });
      const deleteEntry =
        [...entries].reverse().find((e) => e.op === "delete") ?? null;
      const createEntry = entries.find((e) => e.op !== "delete") ?? null;
      const verdict = await sdk.trigger<
        Record<string, never>,
        { ok: boolean }
      >({ function_id: "state::verify", payload: {} });

      const base = {
        obsId,
        title: found.obs.title ?? "(untitled)",
        deletedAt: deleteEntry?.ts ?? new Date().toISOString(),
        deleteEntry,
        createEntry,
        chainIntact: verdict.ok === true,
        contentErased: false as const,
      };
      const receipt: DeleteReceipt = { ...base, receiptHash: receiptHash(base) };
      logger.info("memory forgotten with receipt", {
        obsId,
        oplogDeleteId: deleteEntry?.id,
        chainIntact: receipt.chainIntact,
      });
      return { deleted: true, receipt };
    },
  );
}
