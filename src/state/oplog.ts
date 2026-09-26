//
// Hash-chain helpers for the append-only oplog: a SHA-256 chain that is
// tamper-evident (any edit/reorder/drop breaks the chain at the first touched
// entry). The canonicalization here is the contract that anything signing the
// oplog later would sign over, so it must stay stable.
//
// Two entry versions coexist in one chain:
//
//   v1 (legacy)  hash covers the RAW payload. Erasing a v1 payload therefore
//                breaks the chain — v1 entries can only be erased by
//                `compact`, which re-chains everything as v2.
//   v2 (current) hash covers payload_hash = SHA-256(canonical payload)
//                instead of the payload itself. The payload can be set to
//                NULL in place (erasure) and the chain still verifies,
//                while payload_hash keeps the original content commitment:
//                anyone holding the content can still prove it was (or was
//                not) the erased value.
//
// verifyChain checks each entry under its own version, so mixed chains
// (old v1 history + new v2 tail) verify end to end.

import { createHash } from "node:crypto";
import {
  canonicalize,
  type OplogEntry,
  type OplogOp,
  type OplogPruneOptions,
} from "./store.js";

/** The empty-string sentinel used as `prev_hash` for the genesis entry. */
export const GENESIS_PREV_HASH = "";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Fixed sentinel payload_hash for entries whose payload is null AT WRITE TIME
 * (deletes, and the rare genuine-null value). Distinct from the hash of any
 * real payload, and distinct from an ERASED payload (which keeps the original
 * content's hash) — so "was null all along" and "was erased" stay
 * distinguishable forever.
 */
export const NULL_PAYLOAD_HASH = sha256("memwarden:null-payload");

/** SHA-256 over the canonical payload text; the sentinel for null. */
export function hashPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return NULL_PAYLOAD_HASH;
  return sha256(canonicalize(payload));
}

/**
 * Compute the hash for a v1 (legacy) oplog entry: covers the RAW payload.
 * Kept verbatim so pre-v2 chains keep verifying byte-for-byte.
 */
export function hashOplogEntry(fields: {
  id: number;
  ts: string;
  op: OplogOp;
  scope: string;
  key: string;
  payload: unknown;
  prev_hash: string;
}): string {
  const canonical = canonicalize({
    id: fields.id,
    ts: fields.ts,
    op: fields.op,
    scope: fields.scope,
    key: fields.key,
    payload: fields.payload ?? null,
    prev_hash: fields.prev_hash,
  });
  return sha256(canonical);
}

/**
 * Compute the hash for a v2 entry: covers payload_hash INSTEAD of the raw
 * payload (plus an explicit v marker for domain separation). Because the
 * commitment is to the hash, the payload column can later be nulled in place
 * without breaking the chain.
 */
export function hashOplogEntryV2(fields: {
  id: number;
  ts: string;
  op: OplogOp;
  scope: string;
  key: string;
  payload_hash: string;
  prev_hash: string;
}): string {
  const canonical = canonicalize({
    v: 2,
    id: fields.id,
    ts: fields.ts,
    op: fields.op,
    scope: fields.scope,
    key: fields.key,
    payload_hash: fields.payload_hash,
    prev_hash: fields.prev_hash,
  });
  return sha256(canonical);
}

/** Key for grouping oplog entries by (scope, key). NUL is unambiguous. */
export function pairKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

/** The payload of the `compact` record appended by compactOplog. */
export interface CompactRecordPayload {
  previousHeadHash: string;
  entriesRewritten: number;
  erasedCount: number;
  /**
   * Payloads nulled because a NEWER version of the same key exists, not
   * because anyone asked for deletion. Recorded separately from erasedCount
   * so the chain itself distinguishes storage reclaim from erasure — both
   * appear in erasedIds (verifyChain needs one authorization list), but a
   * reader can tell how many nulls were which.
   */
  prunedCount: number;
  /**
   * EVERY content-committed null payload in the post-compaction chain (the
   * payloads this pass erased or pruned, plus any nulled earlier) — the
   * compact record is the universal erasure authorization, so verifyChain
   * accepts exactly these nulls and rejects any other. This is also the
   * one-time migration for chains erased before erase records existed: their
   * nulls fail verification until a compact re-anchors them.
   */
  erasedIds: number[];
  compactedAt: string;
}

/** Scope/key under which compact records are logged (never a kv scope). */
export const COMPACT_SCOPE = "mem:oplog";
export const COMPACT_KEY = "compact";

/** Scope/key under which erase-authorization records are logged. */
export const ERASE_SCOPE = COMPACT_SCOPE;
export const ERASE_KEY = "erase";

/**
 * The payload of the `erase` record appended by eraseOplogPayloads: the
 * (scope, key) whose history was erased plus the exact entries nulled. The
 * ids + payload_hashes are the authorization verifyChain checks a null
 * payload against — content is never included (an erasure must not
 * re-disclose what it erased).
 */
export interface EraseRecordPayload {
  scope: string;
  key: string;
  erased: Array<{ id: number; payload_hash: string }>;
}

/** Build the chain-recorded `erase` entry for an in-place payload erasure. */
export function buildEraseRecord(fields: {
  id: number;
  ts: string;
  prev_hash: string;
  payload: EraseRecordPayload;
}): OplogEntry {
  const payload_hash = hashPayload(fields.payload);
  return {
    id: fields.id,
    ts: fields.ts,
    op: "erase",
    scope: ERASE_SCOPE,
    key: ERASE_KEY,
    payload: fields.payload,
    v: 2,
    payload_hash,
    prev_hash: fields.prev_hash,
    hash: hashOplogEntryV2({
      id: fields.id,
      ts: fields.ts,
      op: "erase",
      scope: ERASE_SCOPE,
      key: ERASE_KEY,
      payload_hash,
      prev_hash: fields.prev_hash,
    }),
  };
}

export interface CompactPlan {
  /** Every pre-existing entry, rewritten as v2 and re-chained from genesis. */
  entries: OplogEntry[];
  /** The final `compact` record to append (already chained onto `entries`). */
  compactRecord: OplogEntry;
  /** Count of pre-existing entries whose stored fields changed. */
  entriesRewritten: number;
  /** Count of payloads nulled because their record was deleted (erasure). */
  erasedCount: number;
  /** Count of payloads nulled because a newer version exists (pruning). */
  prunedCount: number;
  /** Canonical payload bytes across the input chain. */
  payloadBytesBefore: number;
  /** Canonical payload bytes after, including the new compact record's own. */
  payloadBytesAfter: number;
  /** Head hash of the input chain ("" for an empty log). */
  previousHeadHash: string;
}

/** Canonical-JSON byte size of one payload; 0 for an absent/null payload. */
function payloadBytes(payload: unknown): number {
  if (payload === null || payload === undefined) return 0;
  return Buffer.byteLength(canonicalize(payload), "utf8");
}

/** The per-(scope, key) facts a compaction needs before it can decide any
 * single entry: which op touched each pair last, and which entry holds its
 * newest version. Built from id/op/scope/key alone, so a store can compute it
 * without loading a single payload. */
export interface CompactionIndex {
  lastMutationOp: Map<string, OplogOp>;
  newestVersionId: Map<string, number>;
}

/** Build the CompactionIndex from entries in id order (payloads unused). */
export function buildCompactionIndex(
  entries: Iterable<Pick<OplogEntry, "id" | "op" | "scope" | "key">>,
): CompactionIndex {
  // A pair is delete-tailed when its LAST mutation entry is a delete.
  const lastMutationOp = new Map<string, OplogOp>();
  // The NEWEST payload-bearing entry per pair: the version behind the value a
  // caller can still read. Keyed off the entry id rather than "has a payload
  // right now" so the decision is independent of earlier prunes — pruning the
  // same log twice must plan the same thing. Nothing replays older versions
  // (state::oplog-find strips payloads; no consumer reads oplog history), so
  // everything before this id is dead weight once the user asks for it to be.
  const newestVersionId = new Map<string, number>();
  for (const e of entries) {
    if (e.op === "set" || e.op === "update" || e.op === "delete") {
      lastMutationOp.set(pairKey(e.scope, e.key), e.op);
    }
    if (e.op === "set" || e.op === "update") {
      newestVersionId.set(pairKey(e.scope, e.key), e.id);
    }
  }
  return { lastMutationOp, newestVersionId };
}

/** Counters and anchor a finished CompactionPlanner reports. */
export type CompactSummary = Omit<CompactPlan, "entries">;

/**
 * Streaming form of the compaction planner. Entries are fed one at a time in
 * id order and each rewritten entry is returned immediately, so a store can
 * page through a large oplog holding one page of payloads at a time instead
 * of the whole history (a mature brain's oplog is gigabytes; decoding all of
 * it at once is what used to exhaust the daemon's heap). planCompaction wraps
 * this class, so both stores plan identically by construction.
 */
export class CompactionPlanner {
  private readonly prune: boolean;
  private readonly keepSince: string | undefined;
  private prev = GENESIS_PREV_HASH;
  private lastHash: string | null = null;
  private lastId: number | null = null;
  private entriesRewritten = 0;
  private erasedCount = 0;
  private prunedCount = 0;
  private payloadBytesBefore = 0;
  private payloadBytesAfter = 0;
  private readonly erasedIds: number[] = [];

  constructor(
    private readonly index: CompactionIndex,
    private readonly livePairs: ReadonlySet<string>,
    opts?: OplogPruneOptions,
  ) {
    this.prune = opts?.pruneSuperseded === true;
    this.keepSince = opts?.keepPayloadsSince;
  }

  private isDead(scope: string, key: string): boolean {
    return (
      this.index.lastMutationOp.get(pairKey(scope, key)) === "delete" &&
      !this.livePairs.has(pairKey(scope, key))
    );
  }

  /** Plan one entry (in id order); returns its rewritten form. */
  feed(e: OplogEntry): OplogEntry {
    const hasPayload = e.payload !== null && e.payload !== undefined;
    const mutation = e.op === "set" || e.op === "update";
    const erase = mutation && hasPayload && this.isDead(e.scope, e.key);
    // Superseded: a newer version of this key exists. Checked only when the
    // entry is not already being erased, so erasedCount keeps its exact
    // meaning (a deleted record's history) and no entry is counted twice.
    const superseded =
      this.prune &&
      !erase &&
      mutation &&
      hasPayload &&
      this.index.newestVersionId.get(pairKey(e.scope, e.key)) !== e.id &&
      !(this.keepSince !== undefined && e.ts >= this.keepSince);
    // Keep an existing v2 commitment verbatim (its payload may already be
    // erased); otherwise commit to the payload we still hold.
    const payload_hash =
      e.v === 2 && typeof e.payload_hash === "string"
        ? e.payload_hash
        : hashPayload(e.payload);
    const payload = erase || superseded ? null : (e.payload ?? null);
    const bytes = payloadBytes(e.payload);
    this.payloadBytesBefore += bytes;
    if (payload !== null) this.payloadBytesAfter += bytes;
    const hash = hashOplogEntryV2({
      id: e.id,
      ts: e.ts,
      op: e.op,
      scope: e.scope,
      key: e.key,
      payload_hash,
      prev_hash: this.prev,
    });
    const next: OplogEntry = {
      id: e.id,
      ts: e.ts,
      op: e.op,
      scope: e.scope,
      key: e.key,
      payload,
      v: 2,
      payload_hash,
      prev_hash: this.prev,
      hash,
    };
    if (
      e.v !== 2 ||
      e.payload_hash !== payload_hash ||
      e.prev_hash !== this.prev ||
      e.hash !== hash ||
      erase ||
      superseded
    ) {
      this.entriesRewritten++;
    }
    if (erase) this.erasedCount++;
    else if (superseded) this.prunedCount++;
    // Authorize every content-committed null in the rewritten chain: payloads
    // erased by THIS pass, by earlier erase records, or by a pre-authorization
    // memwarden (the migration case) — the compact record is the re-anchor.
    if (payload === null && payload_hash !== NULL_PAYLOAD_HASH) {
      this.erasedIds.push(e.id);
    }
    this.lastHash = e.hash;
    this.lastId = e.id;
    this.prev = hash;
    return next;
  }

  /** Close the plan: build the anchoring `compact` record. */
  finish(compactedAt: string): CompactSummary {
    const previousHeadHash = this.lastHash ?? GENESIS_PREV_HASH;
    const compactPayload: CompactRecordPayload = {
      previousHeadHash,
      entriesRewritten: this.entriesRewritten,
      erasedCount: this.erasedCount,
      prunedCount: this.prunedCount,
      erasedIds: this.erasedIds,
      compactedAt,
    };
    const compactId = this.lastId !== null ? this.lastId + 1 : 1;
    const compactPayloadHash = hashPayload(compactPayload);
    const compactRecord: OplogEntry = {
      id: compactId,
      ts: compactedAt,
      op: "compact",
      scope: COMPACT_SCOPE,
      key: COMPACT_KEY,
      payload: compactPayload,
      v: 2,
      payload_hash: compactPayloadHash,
      prev_hash: this.prev,
      hash: hashOplogEntryV2({
        id: compactId,
        ts: compactedAt,
        op: "compact",
        scope: COMPACT_SCOPE,
        key: COMPACT_KEY,
        payload_hash: compactPayloadHash,
        prev_hash: this.prev,
      }),
    };
    return {
      compactRecord,
      entriesRewritten: this.entriesRewritten,
      erasedCount: this.erasedCount,
      prunedCount: this.prunedCount,
      payloadBytesBefore: this.payloadBytesBefore,
      // The anchor record is part of what the chain now costs — with pruning
      // its erasedIds list is the one thing compaction ADDS, so it belongs in
      // the "after" number rather than being quietly excluded from it.
      payloadBytesAfter: this.payloadBytesAfter + payloadBytes(compactPayload),
      previousHeadHash,
    };
  }
}

/**
 * Pure compaction planner shared by both stores (parity by construction).
 * Rules:
 * - every entry becomes v2; payload_hash is kept when already present,
 *   otherwise computed from the stored payload (sentinel for null);
 * - the chain is recomputed from genesis with v2 hashing (ids and
 *   timestamps are preserved — history keeps its shape);
 * - a (scope, key) pair is DEAD when its last mutation entry is a delete
 *   AND the caller confirms no live kv row exists (`livePairs`); only dead
 *   pairs' set/update payloads are nulled — live records are never touched;
 * - with `pruneSuperseded`, SUPERSEDED set/update payloads are nulled too:
 *   every version except the newest one for its (scope, key). Tamper-evidence
 *   lives in the chain, not in the payload column — payload_hash is kept, so
 *   each pruned version keeps its content commitment and the chain still
 *   verifies end to end. `keepPayloadsSince` holds a recency window back;
 * - a final `compact` record anchors the pre-compaction head hash, so old
 *   receipts/exports citing pre-compaction hashes have an honest anchor.
 * Array wrapper over CompactionPlanner; stores with large logs stream instead.
 */
export function planCompaction(
  entries: readonly OplogEntry[],
  livePairs: ReadonlySet<string>,
  compactedAt: string,
  opts?: OplogPruneOptions,
): CompactPlan {
  const planner = new CompactionPlanner(buildCompactionIndex(entries), livePairs, opts);
  const rewritten = entries.map((e) => planner.feed(e));
  return { entries: rewritten, ...planner.finish(compactedAt) };
}

/** Erasure authorizations: entry id -> the later records vouching for it. */
export type EraseAuthorizations = Map<number, Array<{ byId: number; payloadHash?: string }>>;

/**
 * Collect erasure authorizations from `erase` and `compact` records: which
 * entry ids a later chain record vouches for having been legitimately nulled.
 * erase records additionally pin the payload_hash they nulled, so a record
 * cannot be repurposed to bless a different entry's erasure. Only erase and
 * compact entries are read, so a store can pass just those rows.
 */
export function collectEraseAuthorizations(
  entries: Iterable<OplogEntry>,
): EraseAuthorizations {
  const authorized: EraseAuthorizations = new Map();
  const add = (id: number, byId: number, payloadHash?: string): void => {
    const list = authorized.get(id) ?? [];
    list.push({ byId, ...(payloadHash === undefined ? {} : { payloadHash }) });
    authorized.set(id, list);
  };
  for (const entry of entries) {
    if (!entry.payload || typeof entry.payload !== "object") continue;
    if (entry.op === "erase") {
      const erased = (entry.payload as { erased?: unknown }).erased;
      if (!Array.isArray(erased)) continue;
      for (const item of erased) {
        if (!item || typeof item !== "object") continue;
        const id = (item as { id?: unknown }).id;
        const ph = (item as { payload_hash?: unknown }).payload_hash;
        if (typeof id === "number") {
          add(id, entry.id, typeof ph === "string" ? ph : undefined);
        }
      }
    } else if (entry.op === "compact") {
      const ids = (entry.payload as { erasedIds?: unknown }).erasedIds;
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id === "number") add(id, entry.id);
      }
    }
  }
  return authorized;
}

/**
 * Streaming chain verifier: feed entries in id order, one at a time. Given
 * the authorizations up front (collectEraseAuthorizations over the erase and
 * compact records), a store can verify a log of any size one page at a time.
 * verifyChain wraps it, so both forms judge every entry identically.
 */
export class ChainVerifier {
  private expectedPrev: string;
  private lastId: number;

  /**
   * `resumeFrom` continues a chain already verified through that entry.
   * `allowUnauthorizedNulls` accepts a content-committed null with no erase
   * or compact record vouching for it: only the pre-compaction check uses it,
   * because compaction is the documented repair for exactly that case.
   */
  constructor(
    private readonly authorized: EraseAuthorizations,
    resumeFrom?: { id: number; hash: string },
    private readonly opts?: { allowUnauthorizedNulls?: boolean },
  ) {
    this.expectedPrev = resumeFrom?.hash ?? GENESIS_PREV_HASH;
    this.lastId = resumeFrom?.id ?? -Infinity;
  }

  /** Returns the entry's id when it breaks the chain, otherwise null. */
  push(entry: OplogEntry): number | null {
    if (entry.id <= this.lastId) return entry.id;
    if (entry.prev_hash !== this.expectedPrev) return entry.id;
    let recomputed: string;
    if (entry.v === 2) {
      if (typeof entry.payload_hash !== "string") return entry.id;
      if (
        entry.payload !== null &&
        entry.payload !== undefined &&
        hashPayload(entry.payload) !== entry.payload_hash
      ) {
        return entry.id;
      }
      if (
        !this.opts?.allowUnauthorizedNulls &&
        (entry.payload === null || entry.payload === undefined) &&
        entry.payload_hash !== NULL_PAYLOAD_HASH &&
        !(this.authorized.get(entry.id) ?? []).some(
          (a) =>
            a.byId > entry.id &&
            (a.payloadHash === undefined || a.payloadHash === entry.payload_hash),
        )
      ) {
        return entry.id; // erased with no authorizing erase/compact record
      }
      recomputed = hashOplogEntryV2({
        id: entry.id,
        ts: entry.ts,
        op: entry.op,
        scope: entry.scope,
        key: entry.key,
        payload_hash: entry.payload_hash,
        prev_hash: entry.prev_hash,
      });
    } else {
      recomputed = hashOplogEntry({
        id: entry.id,
        ts: entry.ts,
        op: entry.op,
        scope: entry.scope,
        key: entry.key,
        payload: entry.payload,
        prev_hash: entry.prev_hash,
      });
    }
    if (recomputed !== entry.hash) return entry.id;
    this.expectedPrev = entry.hash;
    this.lastId = entry.id;
    return null;
  }
}

/**
 * Walk an ordered list of oplog entries and confirm the chain is intact:
 * ids strictly increasing, each entry's prev_hash equal to the prior entry's
 * hash (genesis links to GENESIS_PREV_HASH), and each entry's hash matching a
 * fresh recomputation under that entry's version. For v2 entries a present
 * (non-null) payload must additionally match payload_hash — otherwise an
 * in-place payload edit would go undetected (the entry hash only commits to
 * payload_hash).
 *
 * A null v2 payload is only legitimate when either (a) it was null at write
 * time (payload_hash is the null sentinel — deletes), or (b) a LATER chain
 * record authorizes the erasure: an `erase` record listing this entry's
 * id + payload_hash, or a `compact` record whose erasedIds include it. An
 * unauthorized null — an attacker with db access silently destroying a
 * payload — breaks the chain at that entry. Chains erased by a pre-
 * authorization memwarden fail verification for the same reason; a one-time
 * `memwarden compact` re-anchors them (its record lists every erased id).
 * Returns the id of the first broken entry or null.
 */
export function verifyChain(entries: readonly OplogEntry[]): number | null {
  const verifier = new ChainVerifier(collectEraseAuthorizations(entries));
  for (const entry of entries) {
    const brokenAt = verifier.push(entry);
    if (brokenAt !== null) return brokenAt;
  }
  return null;
}
