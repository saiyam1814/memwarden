//
// StateStore is the single persistence abstraction behind the StateKV
// contract. It preserves the EXACT observable semantics of the original
// two-level KV (src/state/kv.ts + src/mcp/in-memory-kv.ts):
//
// - scope and key are BOTH opaque strings, no prefix/hierarchy semantics
// - get  -> value | null   (null, never undefined, never throws on miss)
// - set  -> upsert, last-write-wins, returns the written value
// - update -> read-or-{}, apply flat {type:"set", path, value} ops, write back
// - delete -> idempotent, no error on missing
// - list -> VALUES only (no keys), exact scope match, insertion order,
// [] on unknown scope
//
// On top of those semantics it adds two things the successor needs that the
// predecessor's file-KV did not surface:
//
// 1. Mutation events. set/update/delete report the affected key, the
// event_type, and the old/new values so the kernel can drive the
// registered type:"state" trigger (events.ts:108-145). The store does
// NOT know about triggers; it just emits and the kernel routes.
// 2. An append-only, hash-chained oplog of every mutation (SQLite-backed
// impl persists it; the memory impl mirrors it in an array). Ed25519
// signing lands in Phase 0b; for now each entry carries a SHA-256
// hash over its canonical bytes plus the previous entry's hash.

/** A single update operation. Only `type:"set"` is ever produced by callers. */
export interface UpdateOp {
  readonly type: string;
  readonly path: string;
  readonly value?: unknown;
}

/** The kind of mutation an oplog entry / mutation event records. */
export type StateEventType = "set" | "update" | "delete";

/**
 * Emitted by the store after a successful mutation. The kernel uses this to
 * fire any registered type:"state" trigger whose scope matches `scope`
 * (payload = {key, event_type, old_value, new_value}).
 *
 * For deletes, `new_value` is undefined. For sets/updates on a previously
 * absent key, `old_value` is undefined.
 */
export interface StateMutationEvent {
  readonly scope: string;
  readonly key: string;
  readonly event_type: StateEventType;
  readonly old_value?: unknown;
  readonly new_value?: unknown;
}

/** Listener invoked synchronously-after-commit for every mutation. */
export type MutationListener = (event: StateMutationEvent) => void;

/**
 * One append-only oplog record. The hash chain makes the log tamper-evident:
 * `hash = sha256(canonical(id, ts, op, scope, key, payload, prev_hash))`.
 * `prev_hash` is the hash of the immediately preceding entry, or the empty
 * string for the genesis entry.
 */
export interface OplogEntry {
  readonly id: number;
  readonly ts: string;
  readonly op: StateEventType;
  readonly scope: string;
  readonly key: string;
  /** The post-mutation value (set/update) or null (delete). JSON value. */
  readonly payload: unknown;
  readonly prev_hash: string;
  readonly hash: string;
}

/**
 * The single persistence chokepoint. All five methods mirror the original
 * StateKV semantics exactly. Implementations: StoreLibsql (durable, libSQL)
 * and StoreMemory (in-process Map mirror, used for parity tests).
 */
export interface StateStore {
  get<T = unknown>(scope: string, key: string): Promise<T | null>;
  set<T = unknown>(scope: string, key: string, value: T): Promise<T>;
  update<T = unknown>(scope: string, key: string, ops: readonly UpdateOp[]): Promise<T>;
  delete(scope: string, key: string): Promise<void>;
  list<T = unknown>(scope: string): Promise<T[]>;

  /**
   * Subscribe to mutation events. Returns an unsubscribe function. Listeners
   * MUST NOT throw; the store wraps them defensively but a throwing listener
   * only affects itself.
   */
  onMutation(listener: MutationListener): () => void;

  /** Read the append-only oplog in id order (optionally from `sinceId`, exclusive). */
  readOplog(sinceId?: number): Promise<OplogEntry[]>;

  /**
   * Verify the oplog hash chain end to end. Returns the id of the first
   * broken link, or null if the chain is intact (or empty).
   */
  verifyOplog(): Promise<{ ok: true } | { ok: false; brokenAt: number }>;

  /** Flush and release any resources (closes the libSQL client). Idempotent. */
  close(): Promise<void>;
}

/**
 * Apply the StateKV `update` op-list to a record, in place semantics returning
 * the mutated record. Shared by both store implementations so their behavior
 * is identical. Only `type:"set"` is honored (verbatim the original implementation semantics:
 * grep-confirmed zero push/inc/delete/append usage); `path` is a flat
 * top-level field name, never dotted. Unknown op types are ignored.
 */
export function applyUpdateOps(
  current: Record<string, unknown>,
  ops: readonly UpdateOp[],
): Record<string, unknown> {
  for (const op of ops) {
    if (op.type === "set") {
      current[op.path] = op.value;
    }
  }
  return current;
}

/**
 * Canonical JSON for hashing/signing: deterministic key ordering so the same
 * logical value always produces the same bytes regardless of insertion order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortValue(obj[key]);
  }
  return out;
}
