//
// HTTP route registrations for the core surface. Each route is a
// registerFunction(id, handler) + registerTrigger({type:"http", ...}) pair
// that validates the request body and delegates to a mem::<x> business
// handler via sdk.trigger (paths prefixed /memwarden, with the
// middleware::api-auth chain). Scope: livez, observe, context, search,
// verify, stats, doctor, export, import.

import type { ApiRequest, ISdk } from "../kernel/index.js";
import type { HookPayload } from "../functions/types.js";
import { getSecret, getQuantBits } from "../functions/config.js";
import { getVectorIndex, getEmbeddingProvider } from "../functions/index.js";
import { QuantizedVectorIndex } from "../functions/quantized-vector-index.js";
import { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { metrics } from "../observability/metrics.js";
import { exportBundle, importBundle, isBrainBundle } from "../bundle/bundle.js";
import { timingSafeCompare } from "./auth.js";

type Response = {
  status_code: number;
  headers?: Record<string, string>;
  body: unknown;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseOptionalFiniteNumber(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseOptionalPositiveInt(value: unknown): number | undefined | null {
  const parsed = parseOptionalFiniteNumber(value);
  if (parsed === undefined || parsed === null) return parsed;
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

/**
 * Inline auth check for handlers that receive the request directly
 * (defense-in-depth alongside the api-auth middleware). When no secret is
 * configured the API is open.
 */
export function checkAuth(
  req: ApiRequest,
  secret: string | undefined,
): Response | null {
  if (!secret) return null;
  const auth = req.headers?.["authorization"] || req.headers?.["Authorization"];
  if (typeof auth !== "string" || !timingSafeCompare(auth, `Bearer ${secret}`)) {
    return { status_code: 401, body: { error: "unauthorized" } };
  }
  return null;
}

/** A host heartbeat row: which agent host last reached the daemon, when. */
export interface HostHeartbeat {
  host: string;
  lastSeen: string;
}

export function registerApiTriggers(sdk: ISdk, secret?: string): void {
  const resolvedSecret = secret ?? getSecret();

  // Liveness heartbeat: hook-driven observe/search calls carry an `agent`
  // field naming their host; persist last-seen per host so `memwarden status`
  // can show wired-vs-actually-flowing. Best-effort — a failed write never
  // fails the request it rode in on.
  async function recordHostHeartbeat(agent: unknown): Promise<void> {
    if (typeof agent !== "string" || !agent.trim()) return;
    const host = agent.trim().slice(0, 64);
    const kv = new StateKV(sdk);
    await kv
      .set<HostHeartbeat>(KV.hostHeartbeats, host, {
        host,
        lastSeen: new Date().toISOString(),
      })
      .catch(() => undefined);
  }

  // --- auth middleware ----------------------------------------------
  // Invoked by the kernel with { request: { headers } }; returns
  // continue/respond. Absent secret = open (continue).
  sdk.registerFunction(
    "middleware::api-auth",
    async (input: {
      request?: { headers?: Record<string, string | undefined> };
    }) => {
      if (!resolvedSecret) return { action: "continue" };
      const headers = input?.request?.headers || {};
      const auth = headers["authorization"] || headers["Authorization"];
      if (
        typeof auth !== "string" ||
        !timingSafeCompare(auth, `Bearer ${resolvedSecret}`)
      ) {
        return {
          action: "respond",
          response: { status_code: 401, body: { error: "unauthorized" } },
        };
      }
      return { action: "continue" };
    },
  );

  // --- GET /memwarden/livez (no auth) -----------------------------
  sdk.registerFunction(
    "api::liveness",
    async (): Promise<Response> => ({
      status_code: 200,
      body: { status: "ok", service: "memwarden" },
    }),
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::liveness",
    config: { api_path: "/memwarden/livez", http_method: "GET" },
  });

  // --- POST /memwarden/observe ------------------------------------
  sdk.registerFunction(
    "api::observe",
    async (req: ApiRequest<HookPayload>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hookType = asNonEmptyString(body["hookType"]);
      const sessionId = asNonEmptyString(body["sessionId"]);
      const project = asNonEmptyString(body["project"]);
      const cwd = asNonEmptyString(body["cwd"]);
      const timestamp = asNonEmptyString(body["timestamp"]);
      if (!hookType || !sessionId || !project || !cwd || !timestamp) {
        return {
          status_code: 400,
          body: {
            error:
              "hookType, sessionId, project, cwd, and timestamp are required strings",
          },
        };
      }
      const payload: HookPayload = {
        hookType: hookType as HookPayload["hookType"],
        sessionId,
        project,
        cwd,
        timestamp,
        data: body["data"],
      };
      // Hook-driven captures name their host; it flows to the observation's
      // agentId (provenance) and the liveness heartbeat.
      const agent = asNonEmptyString(body["agent"]);
      if (agent) payload.agent = agent;
      await recordHostHeartbeat(agent);
      const result = await sdk.trigger({
        function_id: "mem::observe",
        payload,
      });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::observe",
    config: {
      api_path: "/memwarden/observe",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/context ------------------------------------
  sdk.registerFunction(
    "api::context",
    async (
      req: ApiRequest<{ sessionId: string; project: string; budget?: number }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = asNonEmptyString(body["sessionId"]);
      const project = asNonEmptyString(body["project"]);
      if (!sessionId || !project) {
        return {
          status_code: 400,
          body: { error: "sessionId and project are required strings" },
        };
      }
      const budget = parseOptionalPositiveInt(body["budget"]);
      if (budget === null) {
        return {
          status_code: 400,
          body: { error: "budget must be a positive integer" },
        };
      }
      const payload: { sessionId: string; project: string; budget?: number } = {
        sessionId,
        project,
      };
      if (budget !== undefined) payload.budget = budget;
      const result = await sdk.trigger({
        function_id: "mem::context",
        payload,
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::context",
    config: {
      api_path: "/memwarden/context",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/search -------------------------------------
  sdk.registerFunction(
    "api::search",
    async (
      req: ApiRequest<{
        query: string;
        limit?: number;
        project?: string;
        cwd?: string;
        format?: string;
        token_budget?: number;
      }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body["query"] !== "string" || !body["query"].trim()) {
        return {
          status_code: 400,
          body: { error: "query is required and must be a non-empty string" },
        };
      }
      if (
        body["limit"] !== undefined &&
        (!Number.isInteger(body["limit"]) || (body["limit"] as number) < 1)
      ) {
        return {
          status_code: 400,
          body: { error: "limit must be a positive integer" },
        };
      }
      if (body["project"] !== undefined && typeof body["project"] !== "string") {
        return {
          status_code: 400,
          body: { error: "project must be a string" },
        };
      }
      if (body["cwd"] !== undefined && typeof body["cwd"] !== "string") {
        return { status_code: 400, body: { error: "cwd must be a string" } };
      }
      if (
        body["format"] !== undefined &&
        (typeof body["format"] !== "string" ||
          !["full", "compact", "narrative"].includes(
            body["format"].trim().toLowerCase(),
          ))
      ) {
        return {
          status_code: 400,
          body: { error: "format must be one of: full, compact, narrative" },
        };
      }
      if (
        body["token_budget"] !== undefined &&
        (!Number.isInteger(body["token_budget"]) ||
          (body["token_budget"] as number) < 1)
      ) {
        return {
          status_code: 400,
          body: { error: "token_budget must be a positive integer" },
        };
      }
      // Verified Recall fails closed: safe_only needs a repo root to verify
      // against, so reject it rather than silently returning unverified memory.
      if (
        body["safe_only"] === true &&
        (typeof body["cwd"] !== "string" || !(body["cwd"] as string).trim())
      ) {
        return {
          status_code: 400,
          body: { error: "safe_only requires cwd (a repo root to verify against)" },
        };
      }
      const payload: {
        query: string;
        limit?: number;
        project?: string;
        cwd?: string;
        format?: string;
        token_budget?: number;
        safe_only?: boolean;
      } = { query: (body["query"] as string).trim() };
      if (body["limit"] !== undefined) payload.limit = body["limit"] as number;
      if (body["project"] !== undefined)
        payload.project = body["project"] as string;
      if (body["cwd"] !== undefined) payload.cwd = body["cwd"] as string;
      if (typeof body["format"] === "string")
        payload.format = body["format"].trim().toLowerCase();
      if (body["token_budget"] !== undefined)
        payload.token_budget = body["token_budget"] as number;
      if (body["safe_only"] === true) payload.safe_only = true;

      // Session-start injection is a search; its `agent` field only feeds the
      // liveness heartbeat (never the search itself).
      await recordHostHeartbeat(body["agent"]);

      const result = await sdk.trigger({
        function_id: "mem::search",
        payload,
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::search",
    config: {
      api_path: "/memwarden/search",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- GET /memwarden/verify --------------------------------------
  // Tamper-evidence: show the memory store's oplog hash chain is intact.
  // The differentiating guarantee — memory whose history is tamper-evident
  // (detects edits/reorders; not signed, so it is evidence, not proof).
  sdk.registerFunction(
    "api::verify",
    async (): Promise<Response> => {
      const result = (await sdk.trigger({
        function_id: "state::verify",
        payload: {},
      })) as { ok: true } | { ok: false; brokenAt: number };
      const count = (await sdk.trigger({
        function_id: "state::oplog-count",
        payload: {},
      })) as { count: number };
      return {
        status_code: result.ok ? 200 : 409,
        body: {
          verified: result.ok,
          oplogEntries: count.count,
          ...(result.ok ? {} : { brokenAt: result.brokenAt }),
        },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::verify",
    config: {
      api_path: "/memwarden/verify",
      http_method: "GET",
      // Auth'd when a secret is set: oplog state is private brain metadata.
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- GET /memwarden/stats ---------------------------------------
  // Live self-custody dashboard: memory counts, the active embedding
  // provider, and the TurboQuant compression ratio.
  sdk.registerFunction(
    "api::stats",
    async (): Promise<Response> => {
      const kv = new StateKV(sdk);
      const [memories, sessions, hosts] = await Promise.all([
        kv.list(KV.memories).catch(() => []),
        kv.list(KV.sessions).catch(() => []),
        kv.list<HostHeartbeat>(KV.hostHeartbeats).catch(() => []),
      ]);
      const provider = getEmbeddingProvider();
      const vec = getVectorIndex();
      const body: Record<string, unknown> = {
        memories: memories.length,
        sessions: sessions.length,
        vectors: vec?.size ?? 0,
        // Which engine actually serves vector search (VectorBackend label);
        // null when the vector stream is off (BM25-only).
        vectorBackend: vec?.backendLabel ?? null,
        // Which agent hosts have actually reached this daemon, and when —
        // the "live" column of `memwarden status`.
        hosts,
        embedding: provider
          ? { provider: provider.name, dimensions: provider.dimensions }
          : null,
      };
      if (vec instanceof QuantizedVectorIndex) {
        const { dims, paddedDims, bits, rescoreDepth } = vec.params;
        const fullBytes = dims * 4;
        const codeBytes = Math.ceil((paddedDims * bits) / 8) + 4; // codes + norm
        const storedBytes = codeBytes + (rescoreDepth > 0 ? fullBytes : 0);
        body["compression"] = {
          algorithm: "TurboQuant",
          bits: getQuantBits(),
          fullBytesPerVector: fullBytes,
          storedBytesPerVector: storedBytes,
          ratio: Math.round((fullBytes / storedBytes) * 10) / 10,
          rescore: rescoreDepth,
        };
      } else {
        body["compression"] = null;
      }
      body["performance"] = metrics.snapshot();
      return { status_code: 200, body };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::stats",
    config: {
      api_path: "/memwarden/stats",
      http_method: "GET",
      // Auth'd when a secret is set: stats expose memory/session counts.
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/doctor -------------------------------------
  // The memory doctor: audit stored memories for staleness and sourcing
  // against the live repo. The differentiating "is this safe to inject?"
  // surface.
  sdk.registerFunction(
    "api::doctor",
    async (req: ApiRequest<{ root?: string; project?: string }>): Promise<Response> => {
      const body = (req.body ?? {}) as { root?: string; project?: string };
      const report = await sdk.trigger({
        function_id: "mem::doctor",
        payload: { root: body.root, project: body.project },
      });
      return { status_code: 200, body: report };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::doctor",
    config: {
      api_path: "/memwarden/doctor",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/forget --------------------------------------
  // User-initiated deletion with a tamper-evident receipt. Auth'd: deleting
  // memory is as sensitive as reading it.
  sdk.registerFunction(
    "api::forget",
    async (
      req: ApiRequest<{ observation_id?: string; observationId?: string }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as {
        observation_id?: string;
        observationId?: string;
      };
      const observationId =
        asNonEmptyString(body.observation_id) ??
        asNonEmptyString(body.observationId);
      if (!observationId) {
        return { status_code: 400, body: { error: "observation_id is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::forget",
        payload: { observationId },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::forget",
    config: {
      api_path: "/memwarden/forget",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/dejafix/lookup -----------------------------
  // Déjà Fix: surface verified fixes for an error any agent already solved.
  // Returns only fixes whose referenced files still hash-match (Verified
  // Recall) — a stale fix is never returned. cwd is required: it is both the
  // project firewall (a fix learned in repo A never leaks to repo B) and the
  // working tree the fix is verified against.
  sdk.registerFunction(
    "api::dejafix-lookup",
    async (
      req: ApiRequest<{ error_text?: string; errorText?: string; cwd?: string }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as {
        error_text?: string;
        errorText?: string;
        cwd?: string;
      };
      const errorText =
        asNonEmptyString(body.error_text) ?? asNonEmptyString(body.errorText);
      if (!errorText) {
        return { status_code: 400, body: { error: "error_text is required" } };
      }
      const cwd = asNonEmptyString(body.cwd);
      if (!cwd) {
        return {
          status_code: 400,
          body: { error: "cwd is required (the repo to verify fixes against)" },
        };
      }
      const result = await sdk.trigger({
        function_id: "mem::dejafix_lookup",
        payload: { errorText, cwd },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::dejafix-lookup",
    config: {
      api_path: "/memwarden/dejafix/lookup",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/dejafix/record -----------------------------
  // Record a {error -> root cause + fix} so any agent that hits the same error
  // later gets it back. Referenced files are hashed now so drift is detectable.
  sdk.registerFunction(
    "api::dejafix-record",
    async (
      req: ApiRequest<{
        error_text?: string;
        errorText?: string;
        signature?: string;
        fix?: string;
        root_cause?: string;
        rootCause?: string;
        files?: unknown;
        cwd?: string;
        tool?: string;
        session_id?: string;
        sessionId?: string;
      }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fix = asNonEmptyString(body["fix"]);
      if (!fix) {
        return { status_code: 400, body: { error: "fix is required" } };
      }
      const cwd = asNonEmptyString(body["cwd"]);
      if (!cwd) {
        return { status_code: 400, body: { error: "cwd is required" } };
      }
      const errorText =
        asNonEmptyString(body["error_text"]) ??
        asNonEmptyString(body["errorText"]);
      const signature = asNonEmptyString(body["signature"]);
      if (!errorText && !signature) {
        return {
          status_code: 400,
          body: { error: "error_text or signature is required" },
        };
      }
      const files = Array.isArray(body["files"])
        ? (body["files"] as unknown[]).filter(
            (f): f is string => typeof f === "string" && f.trim().length > 0,
          )
        : undefined;
      const payload: Record<string, unknown> = { fix, cwd };
      if (errorText) payload["errorText"] = errorText;
      if (signature) payload["signature"] = signature;
      const rootCause =
        asNonEmptyString(body["root_cause"]) ??
        asNonEmptyString(body["rootCause"]);
      if (rootCause) payload["rootCause"] = rootCause;
      if (files && files.length > 0) payload["files"] = files;
      const tool = asNonEmptyString(body["tool"]);
      if (tool) payload["tool"] = tool;
      const sessionId =
        asNonEmptyString(body["session_id"]) ??
        asNonEmptyString(body["sessionId"]);
      if (sessionId) payload["sessionId"] = sessionId;

      const result = await sdk.trigger({
        function_id: "mem::dejafix_record",
        payload,
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::dejafix-record",
    config: {
      api_path: "/memwarden/dejafix/record",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- GET /memwarden/export --------------------------------------
  // Portability: a self-contained Brain Bundle the user can move between
  // machines or agents. No vendor in the loop.
  sdk.registerFunction(
    "api::export",
    async (): Promise<Response> => {
      const bundle = await exportBundle(new StateKV(sdk));
      return {
        status_code: 200,
        body: { ...bundle, exportedAt: new Date().toISOString() },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::export",
    config: {
      api_path: "/memwarden/export",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/import -------------------------------------
  sdk.registerFunction(
    "api::import",
    async (req: ApiRequest<unknown>): Promise<Response> => {
      const body = req.body;
      if (!isBrainBundle(body)) {
        return {
          status_code: 400,
          body: { error: "body is not a valid memwarden brain bundle" },
        };
      }
      try {
        const counts = await importBundle(new StateKV(sdk), body);
        return { status_code: 200, body: { imported: counts } };
      } catch (err) {
        return {
          status_code: 400,
          body: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::import",
    config: {
      api_path: "/memwarden/import",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });
}
