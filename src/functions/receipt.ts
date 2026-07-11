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
   * Honest scope of the deletion. false: the record is gone from the active
   * store, search, recall, and every index, but the original content still
   * sits inside the local append-only oplog. true (forget --erase, or after
   * `memwarden compact`): the observation's oplog payloads were nulled in
   * place too — the chain still verifies because v2 entry hashes cover the
   * payload's hash, not the payload.
   */
  contentErased: boolean;
  /**
   * Chain head (id + hash) at receipt issuance, identifying WHICH chain the
   * cited entries live in. `memwarden compact` re-chains every hash; receipts
   * issued before a compaction validate against the PRE-compaction chain,
   * whose head hash the compaction record anchors as `previousHeadHash`.
   */
  chainHead: { id: number; hash: string } | null;
  /** SHA-256 over the canonical receipt fields above — offline-checkable. */
  receiptHash: string;
}

export interface ForgetResult {
  deleted: boolean;
  reason?: string;
  receipt?: DeleteReceipt;
  /**
   * Set when --erase was requested but in-place erasure was refused (v1
   * oplog entries present). The forget itself still succeeded; run
   * `memwarden compact` to erase.
   */
  eraseBlocked?: string;
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
    chainHead: fields.chainHead,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function registerReceiptFunction(sdk: ISdk, kv: StateKV): void {
  const forget = async (data: {
    observationId?: string;
    erase?: boolean;
  }): Promise<ForgetResult> => {
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

      // Optional in-place erasure: null this observation's oplog payloads.
      // v2 entry hashes cover payload_hash, so the chain keeps verifying;
      // the store refuses (erasing nothing) when legacy v1 rows are present.
      let contentErased = false;
      let eraseBlocked: string | undefined;
      if (data?.erase === true) {
        const erase = await sdk.trigger<
          { scope: string; key: string },
          { erased: number; refused?: string; v1Count?: number }
        >({
          function_id: "state::oplog-erase",
          payload: { scope: KV.observations(found.sessionId), key: obsId },
        });
        if (erase.refused === "v1-entries") {
          eraseBlocked = `oplog holds ${erase.v1Count ?? "some"} pre-v2 entr${
            (erase.v1Count ?? 2) === 1 ? "y" : "ies"
          } for this memory whose hash covers the raw content — run \`memwarden compact\` to migrate the chain and erase`;
        } else if (erase.refused) {
          eraseBlocked = `erase refused: ${erase.refused}`;
        } else {
          contentErased = true;
        }
      }

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
      const head = await sdk.trigger<
        Record<string, never>,
        { id: number; hash: string }
      >({ function_id: "state::oplog-head", payload: {} });

      const base = {
        obsId,
        title: found.obs.title ?? "(untitled)",
        deletedAt: deleteEntry?.ts ?? new Date().toISOString(),
        deleteEntry,
        createEntry,
        chainIntact: verdict.ok === true,
        contentErased,
        chainHead: head.hash ? { id: head.id, hash: head.hash } : null,
      };
      const receipt: DeleteReceipt = { ...base, receiptHash: receiptHash(base) };
      logger.info("memory forgotten with receipt", {
        obsId,
        oplogDeleteId: deleteEntry?.id,
        chainIntact: receipt.chainIntact,
        contentErased,
      });
      return {
        deleted: true,
        receipt,
        ...(eraseBlocked === undefined ? {} : { eraseBlocked }),
      };
  };

  sdk.registerFunction("mem::forget", forget);
  // mem::erase = forget + in-place oplog payload erasure, one receipt.
  sdk.registerFunction(
    "mem::erase",
    (data: { observationId?: string }): Promise<ForgetResult> =>
      forget({ ...(data ?? {}), erase: true }),
  );
}
