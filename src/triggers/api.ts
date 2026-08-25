//
// HTTP route registrations for the core surface. Each route is a
// registerFunction(id, handler) + registerTrigger({type:"http", ...}) pair
// that validates the request body and delegates to a mem::<x> business
// handler via sdk.trigger (paths prefixed /memwarden, with the
// middleware::api-auth chain). Scope: livez, observe, context, search,
// verify, stats, doctor, bounded Memory/project management, Canon
// export/import, and Brain Bundle export/import.

import type { ApiRequest, ISdk } from "../kernel/index.js";
import type { HookPayload } from "../functions/types.js";
import { getSecret, getQuantBits } from "../functions/config.js";
import {
  getVectorIndex,
  getEmbeddingProvider,
  MANUAL_MEMORY_KINDS,
  MEMORY_LIFECYCLE_ACTIONS,
  ManagementError,
  managementHttpStatus,
  managementProjectRoot,
  transitionStatus,
} from "../functions/index.js";
import type {
  EditManagedMemoryInput,
  EditManagedMemoryResult,
  ListManagedMemoriesInput,
  ManagedHistoryResult,
  ManagedMemoryDetails,
  ManagedMemoryListPage,
  ManagedTransitionInput,
  ProjectListPage,
  RememberMemoryInput,
  RememberMemoryResult,
  TransitionMemoryLifecycleInput,
  TransitionMemoryLifecycleResult,
} from "../functions/index.js";
import { listActiveAgents } from "../functions/fleet.js";
import { summarizeFirewall } from "../functions/firewall-stats.js";
import { QuantizedVectorIndex } from "../functions/quantized-vector-index.js";
import { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { metrics } from "../observability/metrics.js";
import { exportBundle, importBundle, isBrainBundle } from "../bundle/bundle.js";
import {
  CANON_EXPORT_MAX_PAGE,
  isCanonRecord,
  type CanonImportResult,
} from "../functions/canon.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function managementFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status_code: managementHttpStatus(error),
    body: {
      error: message,
      ...(error instanceof ManagementError ? { code: error.code } : {}),
    },
  };
}

function lifecycleSummary(
  memory: Extract<TransitionMemoryLifecycleResult, { ok: true }>["memory"],
): Record<string, unknown> {
  return {
    id: memory.id,
    version: memory.version,
    lifecycle: memory.lifecycle,
    lifecycleReason: memory.lifecycleReason,
    lifecycleChangedAt: memory.lifecycleChangedAt,
    observedAt: memory.observedAt,
    validFrom: memory.validFrom,
    ...(memory.validTo ? { validTo: memory.validTo } : {}),
    ...(memory.parentId ? { parentId: memory.parentId } : {}),
    ...(memory.supersedes ? { supersedes: memory.supersedes } : {}),
    ...(memory.supersededBy ? { supersededBy: memory.supersededBy } : {}),
    transitions: memory.lifecycleTransitions?.length ?? 0,
  };
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
      // `memwarden adopt` marks seeded foreign memories so the capture path
      // records their files without hashing — see HookPayload.adopted.
      if (body["adopted"] === true) payload.adopted = true;
      await recordHostHeartbeat(agent);
      const result = await sdk.trigger({
        function_id: "mem::observe",
        payload,
      });
      // mem::observe refuses some writes (e.g. the session-project mismatch
      // guard). A refusal must not travel as 201 — hooks are fire-and-forget,
      // but anything that DOES read the response deserves the truth.
      const refused =
        typeof result === "object" &&
        result !== null &&
        (result as { success?: boolean }).success === false;
      return { status_code: refused ? 409 : 201, body: result };
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

  // --- POST /memwarden/remember -----------------------------------
  sdk.registerFunction(
    "api::remember",
    async (req: ApiRequest<Record<string, unknown>>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = body["text"];
      const project = asNonEmptyString(body["project"]);
      if (typeof text !== "string" || !text.trim() || !project) {
        return {
          status_code: 400,
          body: { error: "text and project are required strings" },
        };
      }
      if (
        body["title"] !== undefined &&
        (typeof body["title"] !== "string" || !body["title"].trim())
      ) {
        return {
          status_code: 400,
          body: { error: "title must be a non-empty string" },
        };
      }
      if (
        body["kind"] !== undefined &&
        (typeof body["kind"] !== "string" ||
          !(MANUAL_MEMORY_KINDS as readonly string[]).includes(body["kind"]))
      ) {
        return {
          status_code: 400,
          body: { error: `kind must be one of: ${MANUAL_MEMORY_KINDS.join(", ")}` },
        };
      }
      if (
        body["files"] !== undefined &&
        (!Array.isArray(body["files"]) ||
          body["files"].some((file) => typeof file !== "string"))
      ) {
        return {
          status_code: 400,
          body: { error: "files must be an array of project-relative paths" },
        };
      }
      const expiry =
        body["expires_at"] !== undefined
          ? body["expires_at"]
          : body["expiry"] !== undefined
            ? body["expiry"]
            : body["expiresAt"];
      if (
        expiry !== undefined &&
        expiry !== null &&
        (typeof expiry !== "string" ||
          !expiry.trim() ||
          Number.isNaN(new Date(expiry).getTime()))
      ) {
        return {
          status_code: 400,
          body: { error: "expires_at must be null or a valid date-time string" },
        };
      }
      for (const field of ["sessionId", "supersedes", "agent"] as const) {
        if (
          body[field] !== undefined &&
          (typeof body[field] !== "string" || !body[field].trim())
        ) {
          return {
            status_code: 400,
            body: { error: `${field} must be a non-empty string` },
          };
        }
      }

      const payload: RememberMemoryInput = { text, project };
      if (typeof body["title"] === "string") payload.title = body["title"];
      if (typeof body["kind"] === "string") {
        payload.kind = body["kind"] as NonNullable<RememberMemoryInput["kind"]>;
      }
      if (Array.isArray(body["files"])) payload.files = body["files"] as string[];
      if (expiry === null || typeof expiry === "string") payload.expiresAt = expiry;
      if (typeof body["supersedes"] === "string") {
        payload.supersedes = body["supersedes"];
      }
      if (typeof body["sessionId"] === "string") payload.sessionId = body["sessionId"];
      if (typeof body["agent"] === "string") payload.agent = body["agent"];

      await recordHostHeartbeat(payload.agent);
      const result = await sdk.trigger<RememberMemoryInput, RememberMemoryResult>({
        function_id: "mem::remember",
        payload,
      });
      return {
        status_code: result.success ? 201 : 400,
        body: result.success ? result : { error: result.reason ?? "memory was not saved" },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::remember",
    config: {
      api_path: "/memwarden/remember",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/lifecycle ----------------------------------
  // Explicit, bounded semantic transitions. Drift projection remains read-only;
  // this route is the authenticated decision boundary for dispute/archive/
  // revoke/restore/revalidation and explicit supersession.
  sdk.registerFunction(
    "api::lifecycle-transition",
    async (req: ApiRequest<Record<string, unknown>>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const memoryId =
        asNonEmptyString(body["memory_id"]) ??
        asNonEmptyString(body["memoryId"]);
      const action = asNonEmptyString(body["action"]);
      const reason = asNonEmptyString(body["reason"]);
      if (!memoryId || !action || !reason) {
        return {
          status_code: 400,
          body: { error: "memory_id, action, and reason are required" },
        };
      }
      if (memoryId.length > 512) {
        return {
          status_code: 400,
          body: { error: "memory_id must be at most 512 characters" },
        };
      }
      if (
        !MEMORY_LIFECYCLE_ACTIONS.includes(
          action as (typeof MEMORY_LIFECYCLE_ACTIONS)[number],
        )
      ) {
        return {
          status_code: 400,
          body: {
            error: `action must be one of: ${MEMORY_LIFECYCLE_ACTIONS.join(", ")}`,
          },
        };
      }
      if (reason.length > 1_000) {
        return {
          status_code: 400,
          body: { error: "reason must be at most 1000 characters" },
        };
      }
      const actor = asNonEmptyString(body["actor"]);
      if (body["actor"] !== undefined && (!actor || actor.length > 256)) {
        return {
          status_code: 400,
          body: { error: "actor must be a non-empty string of at most 256 characters" },
        };
      }
      const at = asNonEmptyString(body["at"]);
      if (
        body["at"] !== undefined &&
        (!at || !Number.isFinite(Date.parse(at)))
      ) {
        return {
          status_code: 400,
          body: { error: "at must be a valid date-time string" },
        };
      }
      const root = asNonEmptyString(body["root"]);
      const successorId =
        asNonEmptyString(body["successor_id"]) ??
        asNonEmptyString(body["successorId"]);
      if (root && root.length > 4_096) {
        return {
          status_code: 400,
          body: { error: "root must be at most 4096 characters" },
        };
      }
      if (successorId && successorId.length > 512) {
        return {
          status_code: 400,
          body: { error: "successor_id must be at most 512 characters" },
        };
      }
      for (const [field, value] of [
        ["root", body["root"]],
        ["successor_id", body["successor_id"] ?? body["successorId"]],
      ] as const) {
        if (value !== undefined && typeof value !== "string") {
          return {
            status_code: 400,
            body: { error: `${field} must be a string` },
          };
        }
      }
      const payload: TransitionMemoryLifecycleInput = {
        memoryId,
        action: action as TransitionMemoryLifecycleInput["action"],
        reason,
        ...(actor ? { actor } : {}),
        ...(at ? { at } : {}),
        ...(root ? { root } : {}),
        ...(successorId ? { successorId } : {}),
      };
      const result = await sdk.trigger<
        TransitionMemoryLifecycleInput,
        TransitionMemoryLifecycleResult
      >({
        function_id: "mem::lifecycle-transition",
        payload,
      });
      if (result.ok) {
        return {
          status_code: 200,
          body: {
            ok: true,
            memory: lifecycleSummary(result.memory),
            previous: lifecycleSummary(result.previous),
            ...(result.successor
              ? { successor: lifecycleSummary(result.successor) }
              : {}),
            effectiveLifecycle: result.effectiveLifecycle,
            ...(result.sourceStatus
              ? { sourceStatus: result.sourceStatus }
              : {}),
          },
        };
      }
      const status =
        result.code === "not_found"
          ? 404
          : result.code === "write_failed"
            ? 500
            : result.code === "invalid_input"
              ? 400
              : 409;
      return { status_code: status, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::lifecycle-transition",
    config: {
      api_path: "/memwarden/lifecycle",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- bounded Memory management ---------------------------------
  // These routes inventory real Memory rows and always require an explicit
  // project scope (or explicit all_projects for list). No empty-search dump.
  sdk.registerFunction(
    "api::memories-list",
    async (req: ApiRequest<Record<string, unknown>>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const payload = {
        ...(body["project"] !== undefined ? { project: body["project"] } : {}),
        ...(body["all_projects"] !== undefined
          ? { allProjects: body["all_projects"] }
          : {}),
        ...(body["status"] !== undefined ? { status: body["status"] } : {}),
        ...(body["lifecycle"] !== undefined
          ? { lifecycle: body["lifecycle"] }
          : {}),
        ...(body["kind"] !== undefined ? { kind: body["kind"] } : {}),
        ...(body["file"] !== undefined ? { file: body["file"] } : {}),
        ...(body["agent"] !== undefined ? { agent: body["agent"] } : {}),
        ...(body["after"] !== undefined ? { after: body["after"] } : {}),
        ...(body["before"] !== undefined ? { before: body["before"] } : {}),
        ...(body["limit"] !== undefined ? { limit: body["limit"] } : {}),
        ...(body["cursor"] !== undefined ? { cursor: body["cursor"] } : {}),
      } as unknown as ListManagedMemoriesInput;
      try {
        const result = await sdk.trigger<
          ListManagedMemoriesInput,
          ManagedMemoryListPage
        >({ function_id: "mem::memories-list", payload });
        return { status_code: 200, body: result };
      } catch (error) {
        return managementFailure(error);
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memories-list",
    config: {
      api_path: "/memwarden/memories/list",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction(
    "api::memory-show",
    async (req: ApiRequest<Record<string, unknown>>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const result = await sdk.trigger<
          { id: string; project: string; includeContent?: boolean },
          ManagedMemoryDetails | null
        >({
          function_id: "mem::memory-show",
          payload: {
            id: (body["id"] ?? body["memory_id"]) as string,
            project: body["project"] as string,
            ...(body["include_content"] !== undefined
              ? { includeContent: body["include_content"] as boolean }
              : {}),
          },
        });
        return result
          ? { status_code: 200, body: result }
          : { status_code: 404, body: { error: "memory not found in project" } };
      } catch (error) {
        return managementFailure(error);
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-show",
    config: {
      api_path: "/memwarden/memories/show",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction(
    "api::memory-edit",
    async (req: ApiRequest<Record<string, unknown>>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const payload = {
        id: body["id"] ?? body["memory_id"],
        project: body["project"],
        title: body["title"],
        text: body["text"],
        ...(body["kind"] !== undefined ? { kind: body["kind"] } : {}),
        ...(body["files"] !== undefined ? { files: body["files"] } : {}),
        ...(body["no_file_evidence"] !== undefined
          ? { noFileEvidence: body["no_file_evidence"] }
          : {}),
        authoredBy: body["authored_by"],
        ...(body["agent"] !== undefined ? { agent: body["agent"] } : {}),
      } as unknown as EditManagedMemoryInput;
      try {
        const result = await sdk.trigger<EditManagedMemoryInput, EditManagedMemoryResult>({
          function_id: "mem::memory-edit",
          payload,
        });
        return {
          status_code: result.ok
            ? 201
            : result.code === "not_found"
              ? 404
              : result.code === "remember_failed"
                ? 409
                : 400,
          body: result.ok
            ? { ...result, format: "memwarden.memory-edit.v1" }
            : result,
        };
      } catch (error) {
        return managementFailure(error);
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-edit",
    config: {
      api_path: "/memwarden/memories/edit",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  const registerManagedTransition = (
    name: "archive" | "revalidate",
    functionId: "mem::memory-archive" | "mem::memory-revalidate",
  ): void => {
    const apiFunctionId = `api::memory-${name}`;
    sdk.registerFunction(
      apiFunctionId,
      async (req: ApiRequest<Record<string, unknown>>): Promise<Response> => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const id = asNonEmptyString(body["id"] ?? body["memory_id"]);
        const project = asNonEmptyString(body["project"]);
        const reason = asNonEmptyString(body["reason"]);
        if (!id || !project || !reason) {
          return {
            status_code: 400,
            body: { error: "memory_id, project, and reason are required" },
          };
        }
        const actor = asNonEmptyString(body["actor"]);
        if (body["actor"] !== undefined && !actor) {
          return {
            status_code: 400,
            body: { error: "actor must be a non-empty string when provided" },
          };
        }
        const payload: ManagedTransitionInput = {
          id,
          project,
          reason,
          ...(actor ? { actor } : {}),
          ...(name === "revalidate" ? { confirmed: body["confirmed"] === true } : {}),
        };
        try {
          const result = await sdk.trigger<
            ManagedTransitionInput,
            TransitionMemoryLifecycleResult
          >({ function_id: functionId, payload });
          if (!result.ok) {
            return { status_code: transitionStatus(result), body: result };
          }
          return {
            status_code: 200,
            body: {
              format: "memwarden.memory-transition.v1",
              ok: true,
              action: name,
              memory: lifecycleSummary(result.memory),
              previous: lifecycleSummary(result.previous),
              ...(result.successor
                ? { successor: lifecycleSummary(result.successor) }
                : {}),
              effectiveLifecycle: result.effectiveLifecycle,
              ...(result.sourceStatus ? { sourceStatus: result.sourceStatus } : {}),
            },
          };
        } catch (error) {
          return managementFailure(error);
        }
      },
    );
    sdk.registerTrigger({
      type: "http",
      function_id: apiFunctionId,
      config: {
        api_path: `/memwarden/memories/${name}`,
        http_method: "POST",
        middleware_function_ids: ["middleware::api-auth"],
      },
    });
  };
  registerManagedTransition("archive", "mem::memory-archive");
  registerManagedTransition("revalidate", "mem::memory-revalidate");

  sdk.registerFunction(
    "api::memory-history",
    async (req: ApiRequest<Record<string, unknown>>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const result = await sdk.trigger<
          { id: string; project: string; limit?: number },
          ManagedHistoryResult | null
        >({
          function_id: "mem::memory-history",
          payload: {
            id: (body["id"] ?? body["memory_id"]) as string,
            project: body["project"] as string,
            ...(body["limit"] !== undefined
              ? { limit: body["limit"] as number }
              : {}),
          },
        });
        return result
          ? { status_code: 200, body: result }
          : { status_code: 404, body: { error: "memory not found in project" } };
      } catch (error) {
        return managementFailure(error);
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-history",
    config: {
      api_path: "/memwarden/memories/history",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction(
    "api::projects",
    async (req: ApiRequest<Record<string, unknown>>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const result = await sdk.trigger<
          { limit?: number; cursor?: string },
          ProjectListPage
        >({
          function_id: "mem::projects",
          payload: {
            ...(body["limit"] !== undefined
              ? { limit: body["limit"] as number }
              : {}),
            ...(body["cursor"] !== undefined
              ? { cursor: body["cursor"] as string }
              : {}),
          },
        });
        return { status_code: 200, body: result };
      } catch (error) {
        return managementFailure(error);
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::projects",
    config: {
      api_path: "/memwarden/projects",
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
        safe_only?: boolean;
        mode?: string;
        as_of?: string;
        include_drifted?: boolean;
        trust?: string[];
        files?: string[];
        include_memories?: boolean;
        all_projects?: boolean;
      }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const inventory = body["include_memories"] === true;
      if (
        typeof body["query"] !== "string" ||
        (!body["query"].trim() && !inventory)
      ) {
        return {
          status_code: 400,
          body: {
            error:
              "query is required and must be non-empty (except explicit memory inventory)",
          },
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
      if (
        body["mode"] !== undefined &&
        (typeof body["mode"] !== "string" ||
          !["current", "historical", "as_of", "all"].includes(
            (body["mode"] as string).trim().toLowerCase(),
          ))
      ) {
        return {
          status_code: 400,
          body: { error: "mode must be one of: current, historical, as_of, all" },
        };
      }
      if (
        body["as_of"] !== undefined &&
        (typeof body["as_of"] !== "string" ||
          !(body["as_of"] as string).trim() ||
          (body["as_of"] as string).length > 128 ||
          !Number.isFinite(Date.parse(body["as_of"] as string)))
      ) {
        return {
          status_code: 400,
          body: { error: "as_of must be a valid date-time string" },
        };
      }
      if (
        body["include_drifted"] !== undefined &&
        typeof body["include_drifted"] !== "boolean"
      ) {
        return {
          status_code: 400,
          body: { error: "include_drifted must be a boolean" },
        };
      }
      const allowedTrust = new Set([
        "verified",
        "source-verified",
        "sourced",
        "sourced-unverified",
        "unsourced",
        "stale",
        "source-drifted",
        "unverifiable",
      ]);
      if (
        body["trust"] !== undefined &&
        (!Array.isArray(body["trust"]) ||
          body["trust"].length === 0 ||
          !body["trust"].every(
            (item) =>
              typeof item === "string" &&
              allowedTrust.has(item.trim().toLowerCase()),
          ))
      ) {
        return {
          status_code: 400,
          body: {
            error:
              "trust must be a non-empty array of source-verified, sourced, unsourced, source-drifted, or unverifiable",
          },
        };
      }
      if (
        body["files"] !== undefined &&
        (!Array.isArray(body["files"]) ||
          body["files"].length === 0 ||
          body["files"].length > 32 ||
          body["files"].some(
            (file) =>
              typeof file !== "string" ||
              !file.trim() ||
              file.length > 1_024 ||
              file.includes("\0"),
          ))
      ) {
        return {
          status_code: 400,
          body: { error: "files must be a non-empty array of at most 32 bounded paths" },
        };
      }
      const normalizedMode =
        typeof body["mode"] === "string"
          ? body["mode"].trim().toLowerCase()
          : undefined;
      if (
        normalizedMode !== undefined &&
        normalizedMode !== "as_of" &&
        body["as_of"] !== undefined
      ) {
        return {
          status_code: 400,
          body: { error: "as_of is only compatible with mode=as_of" },
        };
      }
      if (normalizedMode === "as_of" && body["as_of"] === undefined) {
        return {
          status_code: 400,
          body: { error: "mode=as_of requires as_of" },
        };
      }
      const requestedMode =
        normalizedMode ?? (body["as_of"] !== undefined ? "as_of" : undefined);
      const aliasMode =
        body["include_drifted"] === true
          ? "all"
          : body["include_drifted"] === false
            ? "current"
            : undefined;
      if (requestedMode && aliasMode && requestedMode !== aliasMode) {
        return {
          status_code: 400,
          body: {
            error:
              "mode conflicts with include_drifted (true means all; false means current)",
          },
        };
      }
      if (
        body["safe_only"] === true &&
        ((requestedMode !== undefined && requestedMode !== "current") ||
          (aliasMode !== undefined && aliasMode !== "current"))
      ) {
        return {
          status_code: 400,
          body: { error: "safe_only is only compatible with mode=current" },
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
        mode?: string;
        as_of?: string;
        include_drifted?: boolean;
        trust?: string[];
        files?: string[];
        include_memories?: boolean;
        all_projects?: boolean;
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
      if (requestedMode !== undefined) payload.mode = requestedMode;
      if (typeof body["as_of"] === "string") payload.as_of = body["as_of"];
      if (typeof body["include_drifted"] === "boolean")
        payload.include_drifted = body["include_drifted"];
      if (Array.isArray(body["trust"]))
        payload.trust = body["trust"].map((item) => String(item));
      if (Array.isArray(body["files"]))
        payload.files = body["files"].map((item) => String(item));
      if (inventory) payload.include_memories = true;
      if (body["all_projects"] === true) payload.all_projects = true;

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

  // Daily-use search is a strict, project-scoped adapter over #56. It forces
  // compact output (no full content) and an explicit labeled inclusion mode.
  sdk.registerFunction(
    "api::memory-search",
    async (req: ApiRequest<Record<string, unknown>>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const query = asNonEmptyString(body["query"]);
      const project = asNonEmptyString(body["project"]);
      const mode =
        body["mode"] === undefined
          ? "current"
          : asNonEmptyString(body["mode"]);
      if (!query || query.length > 10_000 || !project || !mode) {
        return {
          status_code: 400,
          body: {
            error:
              "query (at most 10000 characters), project, and a valid mode are required",
          },
        };
      }
      let scopedProject: string;
      try {
        scopedProject = managementProjectRoot(project);
      } catch (error) {
        return managementFailure(error);
      }
      if (!(["current", "historical", "all", "as_of"] as const).includes(
        mode as "current" | "historical" | "all" | "as_of",
      )) {
        return {
          status_code: 400,
          body: { error: "mode must be current, historical, all, or as_of" },
        };
      }
      const limit = parseOptionalPositiveInt(body["limit"]);
      if (limit === null || (limit !== undefined && limit > 100)) {
        return {
          status_code: 400,
          body: { error: "limit must be an integer between 1 and 100" },
        };
      }
      if (
        body["files"] !== undefined &&
        (!Array.isArray(body["files"]) ||
          body["files"].length === 0 ||
          body["files"].length > 32 ||
          body["files"].some(
            (file) =>
              typeof file !== "string" ||
              !file.trim() ||
              file.length > 1_024 ||
              file.includes("\0"),
          ))
      ) {
        return {
          status_code: 400,
          body: { error: "files must be a non-empty array of at most 32 bounded paths" },
        };
      }
      const trust = body["trust"] ?? body["status"];
      if (
        trust !== undefined &&
        (!Array.isArray(trust) || trust.length === 0 || trust.length > 16)
      ) {
        return {
          status_code: 400,
          body: { error: "status/trust must be a non-empty array of at most 16 labels" },
        };
      }
      const asOf = asNonEmptyString(body["as_of"]);
      if (
        (mode === "as_of" &&
          (!asOf || asOf.length > 128 || !Number.isFinite(Date.parse(asOf)))) ||
        (mode !== "as_of" && body["as_of"] !== undefined)
      ) {
        return {
          status_code: 400,
          body: {
            error:
              mode === "as_of"
                ? "mode=as_of requires a valid as_of date-time"
                : "as_of is only compatible with mode=as_of",
          },
        };
      }
      const payload: Record<string, unknown> = {
        query,
        project: scopedProject,
        cwd: scopedProject,
        mode,
        format: "compact",
        ...(limit !== undefined ? { limit } : {}),
        ...(asOf ? { as_of: asOf } : {}),
        ...(Array.isArray(body["files"])
          ? { files: body["files"].map((file) => String(file)) }
          : {}),
        ...(Array.isArray(trust)
          ? { trust: trust.map((item) => String(item)) }
          : {}),
      };
      try {
        const result = await sdk.trigger({
          function_id: "mem::search",
          payload,
        });
        return {
          status_code: 200,
          body: {
            ...(isRecord(result) ? result : { results: [] }),
            contract: "memwarden.memory-search.v1",
          },
        };
      } catch (error) {
        return {
          status_code: 400,
          body: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-search",
    config: {
      api_path: "/memwarden/memories/search",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/canon/export -------------------------------
  // A bounded inventory of REAL stored Memory rows for exactly one project.
  // This must never be implemented via search: search is ranked, capped, and
  // returns observation-shaped results rather than the durable Memory records
  // whose capture hashes Canon needs.
  sdk.registerFunction(
    "api::canon-export",
    async (
      req: ApiRequest<{ root?: string; cursor?: string; limit?: number }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const root = asNonEmptyString(body["root"]);
      if (!root) {
        return { status_code: 400, body: { error: "root is required" } };
      }
      const limit = parseOptionalPositiveInt(body["limit"]);
      if (limit === null || (limit !== undefined && limit > CANON_EXPORT_MAX_PAGE)) {
        return {
          status_code: 400,
          body: {
            error: `limit must be an integer between 1 and ${CANON_EXPORT_MAX_PAGE}`,
          },
        };
      }
      const cursor =
        body["cursor"] === undefined
          ? undefined
          : asNonEmptyString(body["cursor"]);
      if (body["cursor"] !== undefined && !cursor) {
        return {
          status_code: 400,
          body: { error: "cursor must be a non-empty Memory id" },
        };
      }
      try {
        const result = await sdk.trigger({
          function_id: "mem::canon-export",
          payload: {
            root,
            ...(cursor ? { cursor } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
        });
        return { status_code: 200, body: result };
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
    function_id: "api::canon-export",
    config: {
      api_path: "/memwarden/canon/export",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/canon/import -------------------------------
  // The core handler repeats local hash verification immediately before the
  // write. The route validates shape for a useful 400, but API validation is
  // never the trust boundary (in-process callers cannot bypass the core gate).
  sdk.registerFunction(
    "api::canon-import",
    async (
      req: ApiRequest<{ root?: string; record?: unknown }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const root = asNonEmptyString(body["root"]);
      if (!root) {
        return { status_code: 400, body: { error: "root is required" } };
      }
      if (!isCanonRecord(body["record"])) {
        return {
          status_code: 400,
          body: { error: "record is not a valid supported Canon record" },
        };
      }
      const result = await sdk.trigger<
        { root: string; record: unknown },
        CanonImportResult
      >({
        function_id: "mem::canon-import",
        payload: { root, record: body["record"] },
      });
      if (result.ok) return { status_code: 201, body: result };
      return {
        status_code: result.code === "invalid_record" ? 400 : 409,
        body: result,
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::canon-import",
    config: {
      api_path: "/memwarden/canon/import",
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
        // The bulk of the store is per-session observations — without this,
        // stats could honestly-but-misleadingly report "0 memories" on a
        // store with thousands of captured observations.
        observations: (sessions as Array<{ observationCount?: number }>).reduce(
          (n, s) => n + (typeof s.observationCount === "number" ? s.observationCount : 0),
          0,
        ),
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
        // What the firewall actually did — the difference between claiming
        // protection and showing it.
        firewall: await summarizeFirewall(kv, 30).catch(() => null),
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

  // --- POST /memwarden/fleet/status ---------------------------------
  // Fleet mode (#26): the live swarm view — which agents are active in a
  // project right now, what each is touching, capture counts, last-seen.
  // Registry rows are upserted by mem::observe (see functions/fleet.ts);
  // orchestrators consume this same route via `fleet status --json`.
  sdk.registerFunction(
    "api::fleet-status",
    async (
      req: ApiRequest<{ project?: string; within_ms?: number }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as { project?: string; within_ms?: number };
      if (typeof body.project !== "string" || !body.project.trim()) {
        return {
          status_code: 400,
          body: { error: "project (a path) is required" },
        };
      }
      const kv = new StateKV(sdk);
      const agents =
        typeof body.within_ms === "number" && body.within_ms > 0
          ? await listActiveAgents(kv, body.project, body.within_ms)
          : await listActiveAgents(kv, body.project);
      return { status_code: 200, body: { project: body.project, agents } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::fleet-status",
    config: {
      api_path: "/memwarden/fleet/status",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // --- POST /memwarden/why ----------------------------------------
  // Explain one memory's trust verdict: why it would be injected or refused.
  sdk.registerFunction(
    "api::why",
    async (
      req: ApiRequest<{
        observation_id?: string;
        observationId?: string;
        root?: string;
      }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as {
        observation_id?: string;
        observationId?: string;
        root?: string;
      };
      const observationId =
        asNonEmptyString(body.observation_id) ??
        asNonEmptyString(body.observationId);
      if (!observationId) {
        return { status_code: 400, body: { error: "observation_id is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::why",
        payload: {
          observationId,
          ...(typeof body.root === "string" ? { root: body.root } : {}),
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::why",
    config: {
      api_path: "/memwarden/why",
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
      req: ApiRequest<{
        observation_id?: string;
        observationId?: string;
        erase?: boolean;
      }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as {
        observation_id?: string;
        observationId?: string;
        erase?: boolean;
      };
      const observationId =
        asNonEmptyString(body.observation_id) ??
        asNonEmptyString(body.observationId);
      if (!observationId) {
        return { status_code: 400, body: { error: "observation_id is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::forget",
        payload: { observationId, erase: body.erase === true },
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

  // --- POST /memwarden/compact --------------------------------------
  // One-shot oplog migration + shrink: re-chain every entry as chain v2,
  // erase the payloads of forget-deleted records, anchor the old head hash
  // in a compact record, VACUUM. Auth'd: it rewrites the brain's history
  // file. dry_run reports what would happen without writing.
  //
  // prune_history additionally nulls SUPERSEDED payloads (older versions of
  // keys that were rewritten) — the storage lever, since a mature oplog is
  // mostly outdated versions. keep_days holds a recency window back in full;
  // the cutoff is resolved HERE, against the daemon clock that stamped every
  // oplog ts, rather than trusting a caller-supplied timestamp.
  interface CompactBody {
    dry_run?: boolean;
    dryRun?: boolean;
    prune_history?: boolean;
    keep_days?: number;
  }
  const DEFAULT_KEEP_DAYS = 7;
  sdk.registerFunction(
    "api::compact",
    async (req: ApiRequest<CompactBody>): Promise<Response> => {
      const body = (req.body ?? {}) as CompactBody;
      const prune = body.prune_history === true;
      // A bad keep_days must NOT silently fall back to the default: the caller
      // would believe it pruned with a window it never got.
      if (
        body.keep_days !== undefined &&
        (typeof body.keep_days !== "number" ||
          !Number.isFinite(body.keep_days) ||
          body.keep_days < 0)
      ) {
        return {
          status_code: 400,
          body: { error: "keep_days must be a number >= 0" },
        };
      }
      const keepDays = body.keep_days ?? DEFAULT_KEEP_DAYS;
      const result = await sdk.trigger({
        function_id: "state::compact",
        payload: {
          dryRun: body.dry_run === true || body.dryRun === true,
          ...(prune
            ? {
                pruneSuperseded: true,
                keepPayloadsSince: new Date(
                  Date.now() - keepDays * 86_400_000,
                ).toISOString(),
              }
            : {}),
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::compact",
    config: {
      api_path: "/memwarden/compact",
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
