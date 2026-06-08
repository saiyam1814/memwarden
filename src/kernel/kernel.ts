//
// The memwarden kernel: an in-process worker runtime
// worker runtime. It owns
// - the function registry (Map<id, handler>),
// - the single `trigger` dispatch chokepoint (including the built-in
// `state::*`, `stream::*`, and `engine::workers::list` ids that the
// engine, not app code, used to provide),
// - `registerTrigger` wiring to HTTP / durable-subscriber / state
// surfaces,
// - the optional `on("connection_state")` and `getMeter` shims,
// - the `shutdown` lifecycle.
//
// Persistence lives behind the STATE layer's `StateStore` abstraction
// (../state/store.ts). The kernel routes the five `state::*`
// function_ids to that store and drives any registered `type:"state"`
// trigger from the store's mutation events. The kernel does NOT carry
// its own KV implementation.
//
// HTTP serving is delegated to the router in ./http.ts; the kernel just
// collects route registrations and exposes them.

import {
  TriggerError,
  type ApiResponse,
  type ConnectionStateListener,
  type FunctionHandler,
  type HttpMethod,
  type ISdk,
  type Meter,
  type MiddlewareResult,
  type RegisterWorkerOptions,
  type StateChangeEvent,
  type TriggerConfig,
  type TriggerOptions,
} from "./types.js";
import { PubSub } from "./pubsub.js";
import type {
  StateMutationEvent,
  StateStore,
  UpdateOp,
} from "../state/store.js";
import { StoreMemory } from "../state/store-memory.js";

/** A resolved HTTP route the server can dispatch against. */
export interface HttpRoute {
  method: HttpMethod;
  path: string;
  functionId: string;
  middlewareFunctionIds: string[];
}

export interface KernelOptions {
  /**
   * The persistence store the five `state::*` ids route to. Defaults to
   * an in-memory StoreMemory; the boot path injects a durable
   * StoreLibsql.
   */
  store?: StateStore;
}

const NOOP_METER: Meter = {
  createCounter: () => ({ add: () => {} }),
  createHistogram: () => ({ record: () => {} }),
};

export class Kernel implements ISdk {
  readonly workerName: string;
  private readonly functions = new Map<string, FunctionHandler>();
  private readonly httpRoutes: HttpRoute[] = [];
  private readonly stateTriggers = new Map<string, string[]>(); // scope -> functionIds
  private readonly connectionStateListeners: ConnectionStateListener[] = [];
  private readonly store: StateStore;
  private readonly unsubscribeMutations: () => void;
  private readonly pubsub = new PubSub();
  private shuttingDown = false;
  private lastSwallowedLogAt = 0;

  constructor(opts: RegisterWorkerOptions, kernelOpts: KernelOptions = {}) {
    this.workerName = opts.workerName;
    this.store = kernelOpts.store ?? new StoreMemory();
    // Drive registered type:"state" triggers from the store's mutation
    // events. The store emits {scope, key, event_type, old/new_value};
    // we fan it out to any function bound to that scope.
    this.unsubscribeMutations = this.store.onMutation((event) =>
      this.dispatchStateChange(event),
    );
  }

  // --- registration -------------------------------------------------

  registerFunction(id: string, handler: FunctionHandler): void {
    // Last-write-wins; ids are unique in practice.
    this.functions.set(id, handler);
  }

  registerTrigger(cfg: TriggerConfig): void {
    switch (cfg.type) {
      case "http": {
        this.httpRoutes.push({
          method: cfg.config.http_method,
          path: cfg.config.api_path,
          functionId: cfg.function_id,
          middlewareFunctionIds: cfg.config.middleware_function_ids ?? [],
        });
        break;
      }
      case "durable:subscriber": {
        const fnId = cfg.function_id;
        this.pubsub.subscribe(cfg.config.topic, (payload) => {
          // Subscriber invocation is fire-and-forget; never crash.
          void this.invoke(fnId, payload).catch((err) =>
            this.logSwallowed("durable:subscriber", fnId, err),
          );
        });
        break;
      }
      case "state": {
        const list = this.stateTriggers.get(cfg.config.scope) ?? [];
        list.push(cfg.function_id);
        this.stateTriggers.set(cfg.config.scope, list);
        break;
      }
    }
  }

  on(event: "connection_state", cb: ConnectionStateListener): void {
    if (event === "connection_state") {
      this.connectionStateListeners.push(cb);
      // In-process kernel is "connected" the moment it exists. Fire on
      // the next tick so listeners registered synchronously after
      // construction still observe it.
      queueMicrotask(() => cb("connected"));
    }
  }

  getMeter(_name: string): Meter {
    // No real OTel transport in-process; hand back no-op instruments.
    // The boot path feature-detects this and falls back to NOOP anyway,
    // but providing it keeps the call site identical.
    return NOOP_METER;
  }

  // --- dispatch -----------------------------------------------------

  async trigger<P = any, R = any>(opts: TriggerOptions<P>): Promise<R> {
    const isVoid = !!opts.action?.__void;
    if (isVoid) {
      // Fire-and-forget: never reject toward the caller (many call
      // sites invoke without await, as a bare statement). Run the
      // handler and swallow/log any rejection.
      void this.invoke(opts.function_id, opts.payload).catch((err) =>
        this.logSwallowed("trigger:void", opts.function_id, err),
      );
      return undefined as R;
    }
    return this.invoke<R>(opts.function_id, opts.payload);
  }

  /**
   * Resolve a function_id to a result. Built-in ids are routed here
   * before consulting the app registry. Unregistered ids reject with a
   * TriggerError carrying { code, function_id, message }.
   */
  private async invoke<R = any>(functionId: string, payload: any): Promise<R> {
    const builtin = await this.routeBuiltin<R>(functionId, payload);
    if (builtin !== NOT_BUILTIN) return builtin as R;

    const handler = this.functions.get(functionId);
    if (!handler) {
      throw new TriggerError(
        `No function registered for "${functionId}"`,
        "FUNCTION_NOT_FOUND",
        functionId,
      );
    }
    return (await handler(payload)) as R;
  }

  /**
   * Route engine-provided built-ins: the five `state::*` ops, the
   * `stream::*` surface, and `engine::workers::list`. Returns the
   * sentinel NOT_BUILTIN for everything else. State-change events are
   * emitted by the store (via onMutation), not here, so set/update/delete
   * stay a single store call.
   */
  private async routeBuiltin<R>(
    functionId: string,
    payload: any,
  ): Promise<R | typeof NOT_BUILTIN> {
    switch (functionId) {
      case "state::get": {
        const p = payload as { scope: string; key: string };
        return (await this.store.get(p.scope, p.key)) as R;
      }
      case "state::set": {
        const p = payload as { scope: string; key: string; value: unknown };
        return (await this.store.set(p.scope, p.key, p.value)) as R;
      }
      case "state::update": {
        const p = payload as {
          scope: string;
          key: string;
          ops: ReadonlyArray<UpdateOp>;
        };
        return (await this.store.update(p.scope, p.key, p.ops)) as R;
      }
      case "state::delete": {
        const p = payload as { scope: string; key: string };
        await this.store.delete(p.scope, p.key);
        return undefined as R;
      }
      case "state::list": {
        const p = payload as { scope: string };
        return (await this.store.list(p.scope)) as R;
      }
      case "state::verify": {
        // Tamper-evidence: verify the whole oplog hash chain. Read-only.
        return (await this.store.verifyOplog()) as R;
      }
      case "state::oplog-count": {
        const entries = await this.store.readOplog();
        return { count: entries.length } as R;
      }
      case "stream::set":
      case "stream::send": {
        // Live-viewer surface. Best-effort fan-out to in-process
        // listeners; no durable backing.
        this.pubsub.emitStream(payload ?? {});
        return undefined as R;
      }
      case "engine::workers::list": {
        // Engine-internal in the original; the kernel is the only
        // worker. Health monitor reads `.workers`.
        return { workers: [] } as R;
      }
      default:
        return NOT_BUILTIN;
    }
  }

  /**
   * Fan a store mutation event out to any `type:"state"` trigger bound
   * to that scope. The original only ever subscribed `KV.sessions`, but
   * this generically dispatches for any subscribed scope.
   */
  private dispatchStateChange(event: StateMutationEvent): void {
    const fnIds = this.stateTriggers.get(event.scope);
    if (!fnIds || fnIds.length === 0) return;
    const payload: StateChangeEvent = {
      key: event.key,
      event_type: event.event_type,
      ...(event.old_value !== undefined ? { old_value: event.old_value } : {}),
      ...(event.new_value !== undefined ? { new_value: event.new_value } : {}),
    };
    for (const fnId of fnIds) {
      // State-change handlers are fire-and-forget side effects.
      void this.invoke(fnId, payload).catch((err) =>
        this.logSwallowed("state-change", fnId, err),
      );
    }
  }

  // --- HTTP surface (consumed by ./http.ts) -------------------------

  /** Snapshot of registered HTTP routes. */
  getHttpRoutes(): readonly HttpRoute[] {
    return this.httpRoutes;
  }

  /**
   * Run an ordered middleware chain. Returns the short-circuit response
   * if any middleware responds, else null to proceed.
   */
  async runMiddleware(
    middlewareFunctionIds: string[],
    headers: Record<string, string | undefined>,
  ): Promise<{ status_code: number; body: unknown } | null> {
    for (const id of middlewareFunctionIds) {
      const handler = this.functions.get(id);
      if (!handler) continue; // Missing middleware = open (no-op).
      const result = (await handler({ request: { headers } })) as
        | MiddlewareResult
        | undefined;
      if (result && result.action === "respond") {
        return result.response;
      }
    }
    return null;
  }

  /** Invoke an HTTP-bound function and return its ApiResponse. */
  async invokeHttp(
    functionId: string,
    request: {
      body?: unknown;
      headers?: Record<string, string | undefined>;
      query_params?: Record<string, string>;
    },
  ): Promise<ApiResponse> {
    const handler = this.functions.get(functionId);
    if (!handler) {
      return {
        status_code: 500,
        body: { error: `No handler for ${functionId}` },
      };
    }
    return (await handler(request)) as ApiResponse;
  }

  // --- pub/sub passthrough (for the viewer / external wiring) -------

  get streams(): PubSub {
    return this.pubsub;
  }

  /** The underlying state store (exposed for StateKV construction etc.). */
  get stateStore(): StateStore {
    return this.store;
  }

  // --- lifecycle ----------------------------------------------------

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.unsubscribeMutations();
    for (const cb of this.connectionStateListeners) {
      try {
        cb("disconnected");
      } catch {
        /* ignore */
      }
    }
    await this.store.close().catch(() => undefined);
  }

  // --- internals ----------------------------------------------------

  private logSwallowed(
    context: string,
    functionId: string,
    err: unknown,
  ): void {
    const now = Date.now();
    // Throttle to avoid spamming on bursts of fire-and-forget failures.
    if (now - this.lastSwallowedLogAt < 60_000) return;
    this.lastSwallowedLogAt = now;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[memwarden] swallowed ${context} rejection (${functionId}): ${message}`,
    );
  }
}

const NOT_BUILTIN = Symbol("not-builtin");

/**
 * Factory matching the daemon factory entrypoint. The kernel is a
 * process singleton: repeated calls return the same instance so every
 * module that imports `registerWorker` shares one registry + store.
 */
let singleton: Kernel | null = null;

export function registerWorker(
  _engineUrl: string,
  opts: RegisterWorkerOptions,
  kernelOpts?: KernelOptions,
): Kernel {
  if (!singleton) {
    singleton = new Kernel(opts, kernelOpts ?? {});
  }
  return singleton;
}

/** Test helper: drop the singleton so a fresh kernel can be built. */
export function __resetKernelSingleton(): void {
  singleton = null;
}
