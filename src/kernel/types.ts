//
// Type surface for the memwarden kernel. These types replace the
// an external engine SDK module that the original engine imported. Only the members that
// the wired app code actually touches are modelled here; the kernel
// is an in-process, single-instance runtime so the external-engine
// concepts (otel transport, durable streams, worker fleet) collapse to
// no-ops or in-memory equivalents.

/**
 * HTTP methods the kernel's router understands. Mirrors the
 * `http_method` values used across the wired route registrations.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Request object handed to an HTTP-bound function. The body is the
 * already-JSON-parsed request payload; headers preserve both the
 * lowercase and original-case spellings the app reads.
 */
export interface ApiRequest<T = unknown> {
  body?: T;
  headers?: Record<string, string | undefined>;
  query_params?: Record<string, string>;
}

/**
 * Response shape every HTTP-bound function returns. The kernel sets the
 * status, merges headers, and JSON-stringifies `body`.
 */
export interface ApiResponse {
  status_code: number;
  headers?: Record<string, string>;
  body: unknown;
}

/**
 * Result of an auth/validation middleware function. Either let the
 * request through, or short-circuit with a canned response.
 */
export type MiddlewareResult =
  | { action: "continue" }
  | { action: "respond"; response: { status_code: number; body: unknown } };

/** A registered function: a plain (possibly async) handler. */
export type FunctionHandler = (payload: any) => Promise<any> | any;

/**
 * Fire-and-forget sentinel. `TriggerAction.Void()` marks a trigger call
 * whose result the caller does not await; a rejected Void trigger must
 * never crash the process.
 */
export interface VoidAction {
  __void: true;
}

/** Options accepted by `trigger`. */
export interface TriggerOptions<P = any> {
  function_id: string;
  payload: P;
  action?: VoidAction;
}

/**
 * Discriminated trigger registration config. Binds an
 * already-registered function to an external surface.
 */
export type TriggerConfig =
  | {
      type: "http";
      function_id: string;
      config: {
        api_path: string;
        http_method: HttpMethod;
        middleware_function_ids?: string[];
      };
    }
  | {
      type: "durable:subscriber";
      function_id: string;
      config: { topic: string };
    }
  | {
      type: "state";
      function_id: string;
      config: { scope: string };
    };

/** Payload delivered to a `type:"state"` trigger on every KV mutation. */
export interface StateChangeEvent {
  key: string;
  event_type: "set" | "update" | "delete";
  old_value?: unknown;
  new_value?: unknown;
}

/** Minimal OTel-shaped meter. add/record may be no-ops. */
export interface Counter {
  add: (n: number) => void;
}
export interface Histogram {
  record: (v: number) => void;
}
export interface Meter {
  createCounter: (name: string) => Counter;
  createHistogram: (name: string) => Histogram;
}

/** Connection-state callback. Only `"connection_state"` is observed. */
export type ConnectionStateListener = (state?: unknown) => void;

/**
 * Telemetry / otel metadata accepted by `registerWorker`. Ignored by
 * the in-process kernel beyond being stored for introspection.
 */
export interface RegisterWorkerOptions {
  workerName: string;
  invocationTimeoutMs?: number;
  otel?: {
    serviceName: string;
    serviceVersion: string;
    metricsExportIntervalMs: number;
  };
  telemetry?: {
    project_name: string;
    language: string;
    framework: string;
  };
}

/**
 * The single object the rest of the app talks to. Exactly the members
 * the wired call sites reference. `on` and `getMeter` are optional and
 * feature-detected by callers.
 */
export interface ISdk {
  registerFunction(id: string, handler: FunctionHandler): void;
  trigger<P = any, R = any>(opts: TriggerOptions<P>): Promise<R>;
  registerTrigger(cfg: TriggerConfig): void;
  on?(event: "connection_state", cb: ConnectionStateListener): void;
  shutdown(): Promise<void>;
  getMeter?(name: string): Meter;
}

/**
 * Error carried by a rejected `trigger`. The process-level
 * unhandledRejection handler in the boot entrypoint reads `code`,
 * `function_id`, and `message`.
 */
export class TriggerError extends Error {
  code: string;
  function_id: string;
  constructor(message: string, code: string, functionId: string) {
    super(message);
    this.name = "TriggerError";
    this.code = code;
    this.function_id = functionId;
  }
}
