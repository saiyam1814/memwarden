//
// Hash-chain helpers for the append-only oplog. Phase 0a uses a SHA-256 chain
// (tamper-evident: any edit/reorder/drop breaks the chain at the first touched
// entry). Phase 0b adds Ed25519 signatures over the same canonical bytes; the
// canonicalization here is the contract both phases sign over, so it must stay
// stable.

import { createHash } from "node:crypto";
import { canonicalize, type OplogEntry, type StateEventType } from "./store.js";

/** The empty-string sentinel used as `prev_hash` for the genesis entry. */
export const GENESIS_PREV_HASH = "";

/**
 * Compute the hash for an oplog entry. The hash covers everything that
 * matters for tamper-evidence: identity, time, operation, location, value,
 * and the link to the previous entry. The `hash` field itself is excluded
 * (it is the output).
 */
export function hashOplogEntry(fields: {
  id: number;
  ts: string;
  op: StateEventType;
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
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Walk an ordered list of oplog entries and confirm the chain is intact:
 * ids strictly increasing, each entry's prev_hash equal to the prior entry's
 * hash (genesis links to GENESIS_PREV_HASH), and each entry's hash matching a
 * fresh recomputation. Returns the id of the first broken entry or null.
 */
export function verifyChain(entries: readonly OplogEntry[]): number | null {
  let expectedPrev = GENESIS_PREV_HASH;
  let lastId = -Infinity;
  for (const entry of entries) {
    if (entry.id <= lastId) return entry.id;
    if (entry.prev_hash !== expectedPrev) return entry.id;
    const recomputed = hashOplogEntry({
      id: entry.id,
      ts: entry.ts,
      op: entry.op,
      scope: entry.scope,
      key: entry.key,
      payload: entry.payload,
      prev_hash: entry.prev_hash,
    });
    if (recomputed !== entry.hash) return entry.id;
    expectedPrev = entry.hash;
    lastId = entry.id;
  }
  return null;
}
