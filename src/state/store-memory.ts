//
// In-memory StateStore. A faithful mirror of the original InMemoryKV
// (src/mcp/in-memory-kv.ts) two-level `Map<scope, Map<key, value>>`, extended
// with the `update` method (which the MCP shim never implemented), mutation
// events, and an in-array hash-chained oplog. Used for parity tests against
// StoreLibsql and as a dependency-free fallback.

import {
  applyUpdateOps,
  type MutationListener,
  type OplogEntry,
  type StateEventType,
  type StateMutationEvent,
  type StateStore,
  type UpdateOp,
} from "./store.js";
import { GENESIS_PREV_HASH, hashOplogEntry, verifyChain } from "./oplog.js";

/** Structured-clone a JSON value so callers can never mutate stored state. */
function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export class StoreMemory implements StateStore {
  private readonly store = new Map<string, Map<string, unknown>>();
  private readonly listeners = new Set<MutationListener>();
  private readonly oplog: OplogEntry[] = [];
  private nextOplogId = 1;

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    const value = this.store.get(scope)?.get(key);
    return value === undefined ? null : (clone(value) as T);
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    const scopeMap = this.store.get(scope);
    const old = scopeMap?.get(key);
    const stored = clone(value);
    if (scopeMap) {
      scopeMap.set(key, stored);
    } else {
      this.store.set(scope, new Map([[key, stored]]));
    }
    this.appendOplog("set", scope, key, stored);
    this.emit({
      scope,
      key,
      event_type: "set",
      ...(old === undefined ? {} : { old_value: clone(old) }),
      new_value: clone(stored),
    });
    return value;
  }

  async update<T = unknown>(scope: string, key: string, ops: readonly UpdateOp[]): Promise<T> {
    const scopeMap = this.store.get(scope);
    const existing = scopeMap?.get(key);
    const base =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (clone(existing) as Record<string, unknown>)
        : {};
    const updated = applyUpdateOps(base, ops);
    if (scopeMap) {
      scopeMap.set(key, updated);
    } else {
      this.store.set(scope, new Map([[key, updated]]));
    }
    this.appendOplog("update", scope, key, updated);
    this.emit({
      scope,
      key,
      event_type: "update",
      ...(existing === undefined ? {} : { old_value: clone(existing) }),
      new_value: clone(updated),
    });
    return updated as T;
  }

  async delete(scope: string, key: string): Promise<void> {
    const scopeMap = this.store.get(scope);
    const old = scopeMap?.get(key);
    const existed = scopeMap?.delete(key) ?? false;
    // Idempotent: the original delete is unconditional and never errors, but
    // we only log/emit when something actually changed to keep the oplog clean.
    if (!existed) return;
    this.appendOplog("delete", scope, key, null);
    this.emit({
      scope,
      key,
      event_type: "delete",
      ...(old === undefined ? {} : { old_value: clone(old) }),
    });
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    const scopeMap = this.store.get(scope);
    if (!scopeMap) return [];
    return Array.from(scopeMap.values(), (v) => clone(v) as T);
  }

  onMutation(listener: MutationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async readOplog(sinceId?: number): Promise<OplogEntry[]> {
    const cutoff = sinceId ?? 0;
    return this.oplog.filter((e) => e.id > cutoff).map((e) => ({ ...e }));
  }

  async verifyOplog(): Promise<{ ok: true } | { ok: false; brokenAt: number }> {
    const brokenAt = verifyChain(this.oplog);
    return brokenAt === null ? { ok: true } : { ok: false, brokenAt };
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  private appendOplog(
    op: StateEventType,
    scope: string,
    key: string,
    payload: unknown,
  ): void {
    const id = this.nextOplogId++;
    const ts = new Date().toISOString();
    const prev_hash = this.oplog.length === 0 ? GENESIS_PREV_HASH : this.oplog[this.oplog.length - 1]!.hash;
    const hash = hashOplogEntry({ id, ts, op, scope, key, payload, prev_hash });
    this.oplog.push({ id, ts, op, scope, key, payload: clone(payload), prev_hash, hash });
  }

  private emit(event: StateMutationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listeners must not break the write path.
      }
    }
  }
}
