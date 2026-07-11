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
//      re-disclosing what was deleted (an erase receipt redacts even the
//      title, since the title IS content for prompt observations).
//
// ERASE CASCADE (mem::erase / forget --erase): the observation's content
// also flows into DERIVED records — Session.firstPrompt, Session.summary,
// the KV.summaries handoff, the searchable handoff observation, and Déjà Fix
// capsules recorded from it. Erasing only the observation would leave those
// copies grep-able. So erase RE-DERIVES every session-derived record from
// the remaining observations (as if the erased one never existed) and
// byte-erases the stale derived history: each derived row is deleted, its
// oplog payloads erased (chain-authorized, see oplog.ts), then re-written
// with the re-derived value. Déjà Fix capsules are matched by observationId
// lineage. Honest limits are documented in the README (external copies,
// pre-v2 chains).
//
// The receipt's own hash covers its fields, so a receipt file can be
// checked for integrity on its own, offline.

import { createHash } from "node:crypto";
import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { CompressedObservation, Session, SessionSummary } from "./types.js";
import { KV } from "../state/schema.js";
import { getSearchIndex, vectorIndexRemove, vectorIndexAddGuarded } from "./search.js";
import { deleteAccessLog } from "./access-tracker.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { buildSessionHandoff } from "./handoff.js";
import { DEJAFIX_SCOPE, type FixMemory } from "./dejafix.js";
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
   * payload's hash, not the payload — and session-derived records (session
   * firstPrompt/summary, the stored handoff, Déjà Fix capsules) were
   * re-derived without it, their stale history erased.
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
   * Set when --erase was requested but some in-place erasure was refused
   * (v1 oplog entries present). The forget itself still succeeded; run
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

/** Marks the handoff observation written by mem::observe's session_end path. */
function isHandoffObservation(obs: CompressedObservation | undefined): boolean {
  return (
    !!obs &&
    obs.type === "task" &&
    Array.isArray(obs.concepts) &&
    obs.concepts.includes("session-summary")
  );
}

export function registerReceiptFunction(sdk: ISdk, kv: StateKV): void {
  /**
   * Null the oplog payload history for one (scope, key). Returns a
   * human-readable refusal, or undefined on success/no-op.
   */
  const oplogErase = async (scope: string, key: string): Promise<string | undefined> => {
    const erase = await sdk.trigger<
      { scope: string; key: string },
      { erased: number; refused?: string; v1Count?: number }
    >({ function_id: "state::oplog-erase", payload: { scope, key } });
    if (erase.refused === "v1-entries") {
      return `oplog holds ${erase.v1Count ?? "some"} pre-v2 entr${
        (erase.v1Count ?? 2) === 1 ? "y" : "ies"
      } for this memory whose hash covers the raw content — run \`memwarden compact\` to migrate the chain and erase`;
    }
    if (erase.refused) return `erase refused: ${erase.refused}`;
    return undefined;
  };

  /**
   * Byte-erasing rewrite of a DERIVED record: delete the row, erase its
   * oplog payload history (the pair is deleted at that instant, so the
   * store's live-record refusal does not apply), then re-set the re-derived
   * value. Omit `value` to remove the record entirely. Returns a refusal
   * message when the history erase was blocked (v1 rows); the rewrite of the
   * ACTIVE value still happens either way.
   */
  const rewriteErased = async (
    scope: string,
    key: string,
    value?: unknown,
  ): Promise<string | undefined> => {
    await kv.delete(scope, key);
    const blocked = await oplogErase(scope, key);
    if (value !== undefined) await kv.set(scope, key, value);
    return blocked;
  };

  /**
   * The F3 cascade: re-derive every session-derived record from the
   * remaining observations and byte-erase the stale derived history. Runs
   * under the caller's per-session lock (no observe can interleave).
   */
  const cascadeDerived = async (
    sessionId: string,
    erased: CompressedObservation,
  ): Promise<string[]> => {
    const blocked: string[] = [];
    const remaining = await kv.list<CompressedObservation>(KV.observations(sessionId));
    const session = await kv.get<Session>(KV.sessions, sessionId);

    // Re-derive firstPrompt: the earliest remaining prompt-shaped
    // observation, exactly how observe.ts derived it (collapsed, capped).
    const promptObs = remaining.find((o) => o?.type === "conversation");
    const firstPrompt = promptObs
      ? (promptObs.narrative || promptObs.title || "").replace(/\s+/g, " ").trim().slice(0, 200)
      : undefined;

    const erasedWasHandoff = isHandoffObservation(erased);
    const handoffObs = remaining.find(isHandoffObservation);

    // Re-derive the handoff (Session.summary + KV.summaries + the stored
    // handoff observation) from what remains — deterministic, no LLM, same
    // builder mem::observe used at session_end.
    let newSummary: string | undefined;
    if (handoffObs && !erasedWasHandoff) {
      const rebuilt = buildSessionHandoff({
        obsId: handoffObs.id,
        sessionId,
        timestamp: handoffObs.timestamp,
        project: session?.project,
        firstPrompt,
        agentId: handoffObs.agentId,
        observations: remaining.filter((o) => o?.id !== handoffObs.id),
      });
      newSummary = rebuilt.summaryText;
      const b1 = await rewriteErased(
        KV.observations(sessionId),
        handoffObs.id,
        rebuilt.observation,
      );
      if (b1) blocked.push(`handoff observation: ${b1}`);
      getSearchIndex().remove(handoffObs.id);
      getSearchIndex().add(rebuilt.observation);
      vectorIndexRemove(handoffObs.id);
      await vectorIndexAddGuarded(
        handoffObs.id,
        sessionId,
        rebuilt.observation.title + " " + rebuilt.observation.narrative,
        { kind: "synthetic", logId: handoffObs.id },
      );
      if (session) {
        const b2 = await rewriteErased(KV.summaries, sessionId, rebuilt.sessionSummary);
        if (b2) blocked.push(`session summary: ${b2}`);
      }
    } else if (await kv.get<SessionSummary>(KV.summaries, sessionId)) {
      // The handoff itself was erased (or is gone): the stored summary is
      // wholly derived from it — remove it and erase its history.
      const b = await rewriteErased(KV.summaries, sessionId);
      if (b) blocked.push(`session summary: ${b}`);
    }

    // Re-derive the session row. Its firstPrompt/summary carry observation
    // content, so when those fields exist(ed) the row's oplog history is
    // byte-erased too; a session that never held derived text keeps its
    // history (proportionality: nothing to scrub).
    if (session) {
      const { firstPrompt: _oldPrompt, summary: _oldSummary, ...rest } = session;
      const next: Session = {
        ...rest,
        observationCount: remaining.length,
        ...(firstPrompt ? { firstPrompt } : {}),
        ...(newSummary ? { summary: newSummary } : {}),
      };
      if (session.firstPrompt !== undefined || session.summary !== undefined) {
        const b = await rewriteErased(KV.sessions, sessionId, next);
        if (b) blocked.push(`session row: ${b}`);
      } else {
        await kv.set(KV.sessions, sessionId, next);
      }
    }
    return blocked;
  };

  /**
   * Déjà Fix half of the cascade: capsules record the observationId they
   * were derived from — exact lineage, no string matching needed. Rewrites
   * (or removes) any signature list containing a capsule from this
   * observation, byte-erasing the list's stale history.
   */
  const cascadeDejaFix = async (obsId: string): Promise<string[]> => {
    const blocked: string[] = [];
    const lists = await kv.list<FixMemory[]>(DEJAFIX_SCOPE);
    for (const list of lists) {
      if (!Array.isArray(list) || !list.some((f) => f?.observationId === obsId)) continue;
      const signature = list.find((f) => typeof f?.signature === "string")?.signature;
      if (!signature) continue;
      // Same lock key dejafix.ts uses for this signature's list.
      await withKeyedLock(`dejafix:${signature}`, async () => {
        const current = (await kv.get<FixMemory[]>(DEJAFIX_SCOPE, signature)) ?? [];
        const kept = current.filter((f) => f?.observationId !== obsId);
        const b = await rewriteErased(
          DEJAFIX_SCOPE,
          signature,
          kept.length > 0 ? kept : undefined,
        );
        if (b) blocked.push(`dejafix capsule: ${b}`);
      });
    }
    return blocked;
  };

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
      // With erase, the derived-record cascade runs inside the same lock so
      // no observe can interleave between the deletion and the re-derivation.
      const cascadeBlocked: string[] = [];
      await withKeyedLock(`obs:${found.sessionId}`, async () => {
        await kv.delete(KV.observations(found!.sessionId), obsId);
        getSearchIndex().remove(obsId);
        vectorIndexRemove(obsId);
        await deleteAccessLog(kv, obsId);
        if (data?.erase === true) {
          try {
            cascadeBlocked.push(...(await cascadeDerived(found!.sessionId, found!.obs)));
          } catch (err) {
            // The cascade must never turn a successful delete into a failure;
            // report it instead of hiding it.
            cascadeBlocked.push(
              `derived-record cascade failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      });

      // Optional in-place erasure: null this observation's oplog payloads.
      // v2 entry hashes cover payload_hash, so the chain keeps verifying;
      // every erasure is chain-authorized by an appended `erase` record; the
      // store refuses (erasing nothing) when legacy v1 rows are present.
      let contentErased = false;
      let eraseBlocked: string | undefined;
      if (data?.erase === true) {
        const refusal = await oplogErase(KV.observations(found.sessionId), obsId);
        if (refusal) {
          eraseBlocked = refusal;
        } else {
          contentErased = true;
        }
        try {
          cascadeBlocked.push(...(await cascadeDejaFix(obsId)));
        } catch (err) {
          cascadeBlocked.push(
            `dejafix cascade failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (cascadeBlocked.length > 0) {
          eraseBlocked = [eraseBlocked, ...cascadeBlocked].filter(Boolean).join("; ");
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
        // An erase receipt must not re-disclose what it erased — for prompt
        // observations the title IS the content. Plain forget keeps the
        // title (the record still exists in the oplog anyway).
        title:
          data?.erase === true ? "(erased)" : (found.obs.title ?? "(untitled)"),
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
