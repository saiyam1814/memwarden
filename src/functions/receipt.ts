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
   * INSIDE the hashed receipt (a warning outside the hash would let the
   * receipt alone claim clean success): non-null when --erase could not
   * fully scrub — a v1-blocked oplog erase, or a derived-record refusal.
   * `contentErased` is true only when this is null; the recovery path is
   * `memwarden compact`.
   */
  eraseIncomplete: string | null;
  /**
   * Outcome of the post-erase residual scan (hashed, like every claim):
   * "clean" — no trace of the erased content in the session's remaining
   * records; "residuals" — matches found (named in eraseIncomplete);
   * "limited" — the erased content contains values below the detection
   * floor, so the scan cannot be conclusive and contentErased is refused.
   * null on plain (non-erase) forgets.
   */
  residualScan: "clean" | "residuals" | "limited" | null;
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
    eraseIncomplete: fields.eraseIncomplete,
    residualScan: fields.residualScan,
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

// --- residual content detection ------------------------------------------
//
// An erase receipt's `contentErased: true` is a claim about CONTENT, not one
// record: if the same text also lives in a sibling observation, a preserved
// Outcome line, or a rebuilt summary, the receipt must say so instead of
// claiming clean erasure. Matching is deterministic and best-effort, over
// the erased CONTENT fields only (never paths/provenance, which
// legitimately repeat across records):
//   - 5-word shingles catch shared phrases;
//   - whole short strings (< 5 words, >= 6 chars) catch compact values;
//   - DISTINCTIVE TOKENS catch short secrets — the "PIN 7391" class: any
//     digit-bearing token (>= 3 chars, excluding year-shaped ones, which
//     would false-positive on dates) and any long identifier (>= 12 chars);
//   - SHORT BODY VALUES ("admin"): a body-field string under 6 chars becomes
//     a word-boundary token needle (>= 3 chars). Body fields only — titles
//     are mechanical, and matching "Edit" against every sibling would drown
//     the signal.
// When a body value is SO short it cannot be scanned meaningfully (< 3
// chars), the scan is marked LIMITED and the receipt refuses the headline
// claim rather than overstate it. False positives only ever push
// contentErased toward `false` (never overclaim).

// Title/subtitle are usually mechanical (tool names, "Session handoff: …"),
// so they participate in phrase/whole matching but never in the short-token
// tier — otherwise every erased "Edit" would flag every sibling "Edit".
const MECHANICAL_FIELDS = ["title", "subtitle"] as const;
const BODY_FIELDS = ["narrative", "userPrompt", "assistantResponse"] as const;

function fieldStrings(
  obs: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  const out: string[] = [];
  for (const k of fields) {
    const v = obs[k];
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return out;
}

function bodyStrings(obs: Record<string, unknown>): string[] {
  const out = fieldStrings(obs, BODY_FIELDS);
  const facts = obs["facts"];
  if (Array.isArray(facts)) {
    for (const f of facts) if (typeof f === "string" && f.trim()) out.push(f);
  }
  const raw = obs["raw"];
  if (raw && typeof raw === "object") {
    const t = (raw as Record<string, unknown>)["tool_output"];
    if (typeof t === "string" && t.trim()) out.push(t);
  }
  return out;
}

function contentStrings(obs: Record<string, unknown>): string[] {
  return [...fieldStrings(obs, MECHANICAL_FIELDS), ...bodyStrings(obs)];
}

const SHINGLE_N = 5;

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 0);
}

interface ContentNeedles {
  shingles: Set<string>;
  /** Short-but-distinctive whole values (< SHINGLE_N words, >= 6 chars),
   * stored as NORMALIZED word phrases (`"payment gateway"`) and matched
   * case/spacing/punctuation-insensitively — a sibling echoing "Payment
   * Gateway" must not slip past a value captured as "payment gateway". */
  whole: string[];
  /** Distinctive single tokens: digit-bearing (non-year) or long ids —
   * plus every word (>= 3 chars) of a short BODY value like "admin". */
  tokens: Set<string>;
  /** A body value existed that is too short to scan (< 3 chars): residual
   * verification is incomplete and the receipt must not claim clean. */
  limited: boolean;
}

/** Word-boundary-fenced normalized form for contiguous-phrase matching. */
function fencedWords(text: string): string {
  return ` ${wordsOf(text).join(" ")} `;
}

function isDistinctiveToken(w: string): boolean {
  if (w.length >= 12) return true; // long identifiers / hashes / slugs
  if (w.length >= 3 && /\d/.test(w) && !/^(19|20)\d{2}$/.test(w)) return true;
  return false;
}

function needlesOf(obs: Record<string, unknown>): ContentNeedles {
  const shingles = new Set<string>();
  const whole: string[] = [];
  const tokens = new Set<string>();
  let limited = false;
  const bodySet = new Set(bodyStrings(obs));
  for (const s of contentStrings(obs)) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(s.trim())) continue; // timestamps
    const words = wordsOf(s);
    for (const w of words) if (isDistinctiveToken(w)) tokens.add(w);
    if (words.length >= SHINGLE_N) {
      for (let i = 0; i + SHINGLE_N <= words.length; i++) {
        shingles.add(words.slice(i, i + SHINGLE_N).join(" "));
      }
    } else if (s.trim().length >= 6) {
      // Store NORMALIZED (lowercased, punctuation-collapsed) so a case- or
      // spacing-variant echo in a sibling can't slip past.
      const phrase = words.join(" ");
      if (phrase) whole.push(phrase);
    } else if (bodySet.has(s)) {
      // A short BODY value ("admin"): every word >= 3 chars becomes a
      // word-boundary needle; anything shorter cannot be scanned.
      const scannable = words.filter((w) => w.length >= 3);
      for (const w of scannable) tokens.add(w);
      if (scannable.length === 0) limited = true;
    }
  }
  return { shingles, whole, tokens, limited };
}

function sharesErasedContent(needles: ContentNeedles, text: string): boolean {
  if (!text) return false;
  const words = wordsOf(text);
  if (needles.whole.length > 0) {
    // Contiguous normalized-phrase match (case/spacing/punctuation-insensitive).
    const fenced = fencedWords(text);
    for (const w of needles.whole) if (fenced.includes(` ${w} `)) return true;
  }
  if (needles.tokens.size > 0) {
    for (const w of words) if (needles.tokens.has(w)) return true;
  }
  if (needles.shingles.size === 0) return false;
  for (let i = 0; i + SHINGLE_N <= words.length; i++) {
    if (needles.shingles.has(words.slice(i, i + SHINGLE_N).join(" "))) return true;
  }
  return false;
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
    try {
      return await oplogErase(scope, key);
    } finally {
      // The re-derived value goes back even when the history erase THREW —
      // otherwise a transient store error between delete and set would
      // silently destroy the derived record instead of just leaving its
      // history unscrubbed.
      if (value !== undefined) await kv.set(scope, key, value);
    }
  };

  /**
   * The F3 cascade: re-derive every session-derived record from the
   * remaining observations and byte-erase the stale derived history. Runs
   * under the caller's per-session lock (no observe can interleave), and
   * runs BEFORE the source observation is deleted — so a cascade failure
   * aborts the whole forget and leaves it retryable. `erased` is excluded
   * from "remaining" explicitly.
   */
  const cascadeDerived = async (
    sessionId: string,
    erased: CompressedObservation,
    needles: ContentNeedles,
  ): Promise<string[]> => {
    // ---- phase 1: COMPUTE (reads only — no store mutation) --------------
    // Every re-derived value is computed before the first write, so a write
    // failure partway leaves a partially re-derived (never half-computed)
    // state, and re-running the cascade from the same remaining set is
    // idempotent: it recomputes the identical values and converges.
    const remaining = (
      await kv.list<CompressedObservation>(KV.observations(sessionId))
    ).filter((o) => o?.id !== erased.id);
    const session = await kv.get<Session>(KV.sessions, sessionId);
    const hadStoredSummary =
      (await kv.get<SessionSummary>(KV.summaries, sessionId)) !== null;

    // Re-derive firstPrompt: the earliest remaining prompt-shaped
    // observation, exactly how observe.ts derived it (collapsed, capped).
    const promptObs = remaining.find((o) => o?.type === "conversation");
    const firstPrompt = promptObs
      ? (promptObs.narrative || promptObs.title || "").replace(/\s+/g, " ").trim().slice(0, 200)
      : undefined;

    const erasedWasHandoff = isHandoffObservation(erased);
    const handoffObs = remaining.find(isHandoffObservation);

    let rebuilt: ReturnType<typeof buildSessionHandoff> | undefined;
    let newSummary: string | undefined;
    if (handoffObs && !erasedWasHandoff) {
      // The original handoff's Outcome line came from the host's stop event
      // (assistantResponse) — it exists nowhere else, so the rebuild reads
      // it back out of the stored summary. BUT: an outcome that echoes the
      // erased content would re-inject what we are erasing, so it is dropped
      // when it shares content with the erased observation.
      const outcome = /^Outcome: (.+)$/m.exec(
        session?.summary ?? handoffObs.narrative ?? "",
      )?.[1];
      const outcomeClean =
        outcome && !sharesErasedContent(needles, outcome) ? outcome : undefined;
      rebuilt = buildSessionHandoff({
        obsId: handoffObs.id,
        sessionId,
        timestamp: handoffObs.timestamp,
        project: session?.project,
        firstPrompt,
        agentId: handoffObs.agentId,
        assistantResponse: outcomeClean,
        observations: remaining.filter((o) => o?.id !== handoffObs.id),
      });
      newSummary = rebuilt.summaryText;
    }

    let nextSession: Session | undefined;
    if (session) {
      const { firstPrompt: _oldPrompt, summary: _oldSummary, ...rest } = session;
      nextSession = {
        ...rest,
        observationCount: remaining.length,
        ...(firstPrompt ? { firstPrompt } : {}),
        ...(newSummary ? { summary: newSummary } : {}),
      };
    }

    // ---- phase 2: APPLY (writes) -----------------------------------------
    const blocked: string[] = [];
    if (handoffObs && rebuilt) {
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
    } else if (hadStoredSummary) {
      // The handoff itself was erased (or is gone): the stored summary is
      // wholly derived from it — remove it and erase its history.
      const b = await rewriteErased(KV.summaries, sessionId);
      if (b) blocked.push(`session summary: ${b}`);
    }

    // Re-derive the session row. Its firstPrompt/summary carry observation
    // content, so when those fields exist(ed) the row's oplog history is
    // byte-erased too; a session that never held derived text keeps its
    // history (proportionality: nothing to scrub).
    if (session && nextSession) {
      if (session.firstPrompt !== undefined || session.summary !== undefined) {
        const b = await rewriteErased(KV.sessions, sessionId, nextSession);
        if (b) blocked.push(`session row: ${b}`);
      } else {
        await kv.set(KV.sessions, sessionId, nextSession);
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
      //
      // ORDER MATTERS for resumability: with erase, both cascades run FIRST,
      // while the source observation still exists. If a cascade throws, the
      // whole forget aborts with nothing deleted — `memwarden forget <id>
      // --erase` can simply be retried. (The old order deleted the source
      // first; a cascade failure then left derived copies behind with no
      // record left to retry against.) Cascade REFUSALS (v1 oplog rows) are
      // not failures: they collect into the receipt's eraseIncomplete.
      const needles = needlesOf(found.obs as unknown as Record<string, unknown>);
      const cascadeBlocked: string[] = [];
      let cascadeFailed: string | undefined;
      await withKeyedLock(`obs:${found.sessionId}`, async () => {
        if (data?.erase === true) {
          try {
            cascadeBlocked.push(
              ...(await cascadeDerived(found!.sessionId, found!.obs, needles)),
            );
            cascadeBlocked.push(...(await cascadeDejaFix(obsId)));
          } catch (err) {
            cascadeFailed = err instanceof Error ? err.message : String(err);
            return;
          }
        }
        await kv.delete(KV.observations(found!.sessionId), obsId);
        getSearchIndex().remove(obsId);
        vectorIndexRemove(obsId);
        await deleteAccessLog(kv, obsId);
      });
      if (cascadeFailed !== undefined) {
        // HONEST partial-failure semantics: the SOURCE memory was not
        // deleted, but the cascade applies its writes sequentially, so
        // derived records (handoff / summary / session row) may already be
        // partially re-derived. The cascade computes every value before
        // writing and is idempotent over the same remaining set — retrying
        // converges to the fully re-derived state.
        return {
          deleted: false,
          reason:
            `erase cascade failed (${cascadeFailed}). The source memory was NOT ` +
            `deleted; derived records may be partially re-derived. Retrying ` +
            `\`memwarden forget ${obsId} --erase\` is safe and converges.`,
        };
      }

      // Optional in-place erasure: null this observation's oplog payloads.
      // v2 entry hashes cover payload_hash, so the chain keeps verifying;
      // every erasure is chain-authorized by an appended `erase` record; the
      // store refuses (erasing nothing) when legacy v1 rows are present.
      // This must run AFTER the row delete (the store refuses to erase a
      // live record); if it fails here the row is already gone, so the
      // recovery path is `memwarden compact` — and the receipt says so.
      let sourceErased = false;
      let eraseBlocked: string | undefined;
      let residualScan: "clean" | "residuals" | "limited" = "clean";
      if (data?.erase === true) {
        let refusal: string | undefined;
        try {
          refusal = await oplogErase(KV.observations(found.sessionId), obsId);
        } catch (err) {
          refusal =
            `oplog erase failed (${err instanceof Error ? err.message : String(err)}) — ` +
            `run \`memwarden compact\` to erase`;
        }
        if (refusal) {
          eraseBlocked = refusal;
        } else {
          sourceErased = true;
        }
        if (cascadeBlocked.length > 0) {
          eraseBlocked = [eraseBlocked, ...cascadeBlocked].filter(Boolean).join("; ");
        }

        // RESIDUAL VERIFICATION: `contentErased: true` is a claim about the
        // CONTENT, so scan what remains in this session — sibling
        // observations, the session row, the stored summary — for text the
        // erased observation carried. Independent records that echo it
        // (e.g. an assistant outcome quoting the erased prompt) are NOT
        // silently deleted (they are their own memories); the receipt
        // reports them and points at the fix.
        const residuals: string[] = [];
        const remainingObs = await kv.list<CompressedObservation>(
          KV.observations(found.sessionId),
        );
        for (const o of remainingObs) {
          if (!o?.id) continue;
          const text = contentStrings(o as unknown as Record<string, unknown>).join("\n");
          if (sharesErasedContent(needles, text)) residuals.push(o.id);
        }
        const sessRow = await kv.get<Session>(KV.sessions, found.sessionId);
        if (
          sessRow &&
          sharesErasedContent(
            needles,
            [sessRow.firstPrompt, sessRow.summary].filter(Boolean).join("\n"),
          )
        ) {
          residuals.push("session row (firstPrompt/summary)");
        }
        const summaryRow = await kv.get<SessionSummary>(KV.summaries, found.sessionId);
        if (
          summaryRow &&
          sharesErasedContent(needles, JSON.stringify(summaryRow))
        ) {
          residuals.push("stored session summary");
        }
        if (residuals.length > 0) {
          residualScan = "residuals";
          const note =
            `erased content still appears in: ${residuals.join(", ")} — ` +
            `independent records are not silently deleted; forget them too, then \`memwarden compact\``;
          eraseBlocked = [eraseBlocked, note].filter(Boolean).join("; ");
        } else if (needles.limited) {
          residualScan = "limited";
          const note =
            `the erased content contains values below the residual-detection floor ` +
            `(< 3 chars); the scan cannot be conclusive — review this session's records ` +
            `and run \`memwarden compact\``;
          eraseBlocked = [eraseBlocked, note].filter(Boolean).join("; ");
        }
      }
      // contentErased is the receipt's headline claim: true ONLY when the
      // source payloads were nulled, every derived copy was scrubbed, AND
      // the residual scan came back conclusively clean. A limited scan
      // refuses the claim instead of overstating it.
      const contentErased =
        sourceErased &&
        cascadeBlocked.length === 0 &&
        eraseBlocked === undefined &&
        residualScan !== "limited";

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
        eraseIncomplete: data?.erase === true ? (eraseBlocked ?? null) : null,
        residualScan: data?.erase === true ? residualScan : null,
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
