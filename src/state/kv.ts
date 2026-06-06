//
// StateKV is the SINGLE persistence chokepoint for every mem:: function. It is
// a thin wrapper that turns five methods (get/set/update/delete/list over
// scope+key) into one `trigger` dispatch. This is a verbatim port of
// the original src/state/kv.ts; the only change is the dependency seam: the
// trigger sink is now the in-process kernel (replacing the external engine SDK) rather than an
// external engine. The five built-in `state::*` function_ids are routed by the
// kernel to a StateStore (see store.ts, store-libsql.ts, store-memory.ts).
//
// Compatibility: `StateKV` is constructed from the kernel's `ISdk` (the
// in-process replacement for the external engine SDK). The constructor's parameter type is
// the local `TriggerSink`, which is the exact structural subset of `ISdk` that
// StateKV touches (`trigger`); the kernel's `ISdk` is therefore assignable with
// no adapter. `ISdk` is re-exported below for callers that want the precise
// kernel type at the construction site (`new StateKV(kernel)`). Keeping the
// constructor parameter as the narrow `TriggerSink` lets the STATE layer build
// and unit-test without a hard dependency on the KERNEL layer's build order,
// while remaining 100% compatible with it.

/** Built-in state function ids the kernel routes to the StateStore. */
export const STATE_FUNCTION_IDS = {
  get: "state::get",
  set: "state::set",
  update: "state::update",
  delete: "state::delete",
  list: "state::list",
} as const;

/** A single update operation. Only `type:"set"` is ever produced by callers. */
export interface KvUpdateOp {
  type: string;
  path: string;
  value?: unknown;
}

/**
 * The single dispatch method StateKV depends on. Structurally a subset of the
 * kernel's `ISdk` (the `trigger` member from the kernel contract). Defined
 * locally so STATE has no build-time dependency on KERNEL; the kernel's `ISdk`
 * is assignable to this.
 */
export interface TriggerSink {
  trigger<P = unknown, R = unknown>(opts: {
    function_id: string;
    payload: P;
    action?: unknown;
  }): Promise<R>;
}

/**
 * Five-method KV facade over the kernel trigger chokepoint. Semantics match
 * the original implementation exactly:
 *   - get  -> T | null      (null on miss, never throws)
 *   - set  -> upsert, returns the written value (last-write-wins)
 *   - update -> read-or-{}, apply flat set-ops, write back, return updated
 *   - delete -> idempotent, void
 *   - list -> values only, exact scope match, insertion order, [] on miss
 */
export class StateKV {
  constructor(private readonly sdk: TriggerSink) {}

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    return this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: STATE_FUNCTION_IDS.get,
      payload: { scope, key },
    });
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: STATE_FUNCTION_IDS.set,
      payload: { scope, key, value },
    });
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<KvUpdateOp>,
  ): Promise<T> {
    return this.sdk.trigger<
      { scope: string; key: string; ops: Array<KvUpdateOp> },
      T
    >({
      function_id: STATE_FUNCTION_IDS.update,
      payload: { scope, key, ops },
    });
  }

  async delete(scope: string, key: string): Promise<void> {
    return this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: STATE_FUNCTION_IDS.delete,
      payload: { scope, key },
    });
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    return this.sdk.trigger<{ scope: string }, T[]>({
      function_id: STATE_FUNCTION_IDS.list,
      payload: { scope },
    });
  }
}

// Re-export the kernel's `ISdk` so construction sites can name the precise
// type the kernel hands them: `new StateKV(kernel)`. The kernel barrel
// (../kernel/index.js) is the module that replaces the external engine SDK; its `ISdk` is
// assignable to `StateKV`'s `TriggerSink` constructor parameter.
export type { ISdk } from "../kernel/index.js";
