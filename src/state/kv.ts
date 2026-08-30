//
// StateKV is the single persistence chokepoint for every mem:: function. It
// turns the original five operations (get/set/update/delete/list over scope +
// key), plus an additive bounded keyset page, into trigger dispatches. The
// kernel routes these state::* function ids to a StateStore (store.ts /
// store-libsql.ts / store-memory.ts).
//
// The constructor takes the narrow TriggerSink (just the `trigger` method) so
// the state layer has no build-time dependency on the kernel; the kernel's ISdk
// is structurally assignable and re-exported below for `new StateKV(kernel)`.

/** Built-in state function ids the kernel routes to the StateStore. */
export const STATE_FUNCTION_IDS = {
  get: "state::get",
  set: "state::set",
  update: "state::update",
  delete: "state::delete",
  list: "state::list",
  listPage: "state::list-page",
} as const;

/** A single flat update operation; callers only ever produce `type:"set"`. */
export interface KvUpdateOp {
  type: string;
  path: string;
  value?: unknown;
}

/** The one dispatch method StateKV needs; the kernel's ISdk satisfies it. */
export interface TriggerSink {
  trigger<P = unknown, R = unknown>(opts: {
    function_id: string;
    payload: P;
    action?: unknown;
  }): Promise<R>;
}

/**
 * Five-method KV facade over the kernel trigger chokepoint:
 *   get    -> T | null  (null on miss, never throws)
 *   set    -> upsert, returns the written value (last write wins)
 *   update -> read-or-{}, apply flat set-ops, write back, return result
 *   delete -> idempotent, void
 *   list   -> values only, exact scope match, insertion order, [] on miss
 */
export class StateKV {
  constructor(private readonly sdk: TriggerSink) {}

  private call<P, R>(functionId: string, payload: P): Promise<R> {
    return this.sdk.trigger<P, R>({ function_id: functionId, payload });
  }

  get<T = unknown>(scope: string, key: string): Promise<T | null> {
    return this.call<{ scope: string; key: string }, T | null>(
      STATE_FUNCTION_IDS.get,
      { scope, key },
    );
  }

  set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.call<{ scope: string; key: string; value: T }, T>(
      STATE_FUNCTION_IDS.set,
      { scope, key, value },
    );
  }

  update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<KvUpdateOp>,
  ): Promise<T> {
    return this.call<{ scope: string; key: string; ops: Array<KvUpdateOp> }, T>(
      STATE_FUNCTION_IDS.update,
      { scope, key, ops },
    );
  }

  delete(scope: string, key: string): Promise<void> {
    return this.call<{ scope: string; key: string }, void>(
      STATE_FUNCTION_IDS.delete,
      { scope, key },
    );
  }

  list<T = unknown>(scope: string): Promise<T[]> {
    return this.call<{ scope: string }, T[]>(STATE_FUNCTION_IDS.list, { scope });
  }

  listPage<T = unknown>(
    scope: string,
    options: { after?: string; limit: number },
  ): Promise<{ entries: Array<{ key: string; value: T }>; hasMore: boolean }> {
    return this.call<
      { scope: string; after?: string; limit: number },
      { entries: Array<{ key: string; value: T }>; hasMore: boolean }
    >(STATE_FUNCTION_IDS.listPage, {
      scope,
      ...(options.after === undefined ? {} : { after: options.after }),
      limit: options.limit,
    });
  }
}

// Re-exported so construction sites can name the exact kernel type the kernel
// hands them (`new StateKV(kernel)`); it is assignable to TriggerSink.
export type { ISdk } from "../kernel/index.js";
