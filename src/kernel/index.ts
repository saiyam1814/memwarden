//
// Public barrel for the memwarden kernel. This is the module that
// replaces the external engine SDK for ported app code: it exports the
// `registerWorker` factory, the `TriggerAction` value, and the
// `ISdk` / `ApiRequest` types the call sites import.

import type { VoidAction } from "./types.js";

export { registerWorker, Kernel, __resetKernelSingleton } from "./kernel.js";
export type { HttpRoute, KernelOptions } from "./kernel.js";
export { startHttpServer } from "./http.js";
export type { HttpServerOptions, RunningHttpServer } from "./http.js";
export { PubSub } from "./pubsub.js";
export type { StreamItem } from "./pubsub.js";

export { TriggerError } from "./types.js";
export type {
  ApiRequest,
  ApiResponse,
  ConnectionStateListener,
  Counter,
  FunctionHandler,
  Histogram,
  HttpMethod,
  ISdk,
  Meter,
  MiddlewareResult,
  RegisterWorkerOptions,
  StateChangeEvent,
  TriggerConfig,
  TriggerOptions,
  VoidAction,
} from "./types.js";

/**
 * Fire-and-forget trigger sentinel. Ported app code does
 * `import { TriggerAction } from "<kernel>"` and calls
 * `TriggerAction.Void()` to mark a trigger whose result is not awaited.
 * `trigger` recognizes the `{ __void: true }` sentinel and swallows any
 * rejection so a fire-and-forget failure never crashes the process.
 */
export const TriggerAction = {
  Void(): VoidAction {
    return { __void: true };
  },
} as const;
