//
// Dependency-free MCP server for memwarden. A hand-rolled JSON-RPC 2.0
// dispatcher over stdio — no @modelcontextprotocol/sdk — so the core stays
// lean and self-contained, and the dispatcher is unit-testable without a
// host or a pipe. It proxies to a running memwarden daemon over HTTP, so
// every MCP client (Claude Code, Cursor, Claude Desktop, Cline, Windsurf)
// shares the one local brain.
//
// Beyond the usual save/search/context tools, it exposes the two memwarden
// has and others don't: memory_verify (tamper-evident oplog integrity) and
// memory_stats (live TurboQuant compression ratio).
//
// It also exposes an MCP *prompt*, `recall`, which clients surface as a
// slash command (in Claude Code: `/mcp__memwarden__recall <query>`). The
// user types it mid-chat, the server searches the project's memory and
// returns the matching context as a message the client injects into the
// conversation — on-demand recall from within any MCP-aware tool.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalizePath } from "../functions/paths.js";
import { frameMemoryBlock } from "../functions/injection-format.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "memwarden";
const SERVER_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
        "utf8",
      ),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// Fallback sessionId for memory_remember calls that name none. It must be
// derived from project identity: a session's project metadata is fixed at
// creation, so a shared literal "mcp" session created under project A would
// make every later default remember from project B searchable under A and
// invisible to B. Hashing the canonical project path gives each project its
// own long-lived MCP session without touching the observe path.
export function projectScopedSessionId(prefix: string, project: string): string {
  const hash = createHash("sha256")
    .update(canonicalizePath(project))
    .digest("hex")
    .slice(0, 12);
  return `${prefix}-${hash}`;
}

export interface McpServerOptions {
  baseUrl: string; // e.g. http://localhost:3111
  secret?: string;
  fetchFn?: typeof fetch; // injectable for tests
  // Working directory this MCP server was launched in. MCP clients launch
  // the server inside the workspace, so this is the project the agent is
  // in — used to auto-scope recall so the agent never has to name it.
  cwd?: string;
  // Self-heal hook: called when a daemon request fails with a network error
  // (daemon down). The bin wires this to ensureDaemon so a dead daemon is
  // revived on demand and the request retried — no human in the loop.
  ensureUp?: () => Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<unknown>;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export function createMcpServer(opts: McpServerOptions) {
  const base = opts.baseUrl.replace(/\/$/, "");
  const doFetch = opts.fetchFn ?? fetch;
  const serverCwd = opts.cwd ?? process.cwd();

  async function api(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.secret) headers["authorization"] = `Bearer ${opts.secret}`;
    const init = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    // One self-heal retry: a network error means the daemon is down; revive
    // it and try again so the user's request just works.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await doFetch(`${base}${path}`, init);
        const text = await res.text();
        // An HTTP error must NOT look like an empty-but-successful result —
        // otherwise a secured daemon's 401 (secret missing/mismatched in this
        // process) silently reads as "no memory" and auto-recall dies with no
        // sign of the real cause. Surface it as a thrown error the tool layer
        // turns into a visible isError result.
        if (!res.ok) {
          const detail =
            res.status === 401
              ? "unauthorized — the daemon requires a secret this MCP server can't resolve " +
                "(set MEMWARDEN_SECRET or ensure <dataDir>/secret is readable)"
              : `daemon returned HTTP ${res.status}`;
          throw new Error(`memwarden ${path}: ${detail}`);
        }
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text, status: res.status };
        }
      } catch (err) {
        // Retry once only on a genuine network error (daemon down). An HTTP
        // error (e.g. 401) is deterministic — reviving the daemon won't fix
        // it, so don't loop; rethrow.
        const isNetworkError = !(err instanceof Error && err.message.startsWith("memwarden "));
        if (attempt === 0 && isNetworkError && opts.ensureUp) {
          await opts.ensureUp();
          continue;
        }
        throw err;
      }
    }
  }

  const tools: ToolDef[] = [
    {
      name: "memory_resume",
      description:
        "Recall what was being worked on in THIS project, across every past session and every agent (Claude, Codex, Cursor, …). Call this whenever the user references earlier work — e.g. 'continue what we were doing', 'review the project Claude and I built', 'what was I working on here', 'pick up from the last session'. Returns a narrative digest of the relevant prior context, already scoped to the current working directory, ready to act on.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to focus the recall on (e.g. 'the auth refactor', 'review the project'). Optional but improves relevance.",
          },
          cwd: {
            type: "string",
            description:
              "Working directory to scope to. Defaults to where this server was launched (the current project).",
          },
          token_budget: {
            type: "number",
            description: "Max tokens of context to return (default 2000).",
          },
        },
      },
      call: (a) =>
        api("POST", "/memwarden/search", {
          query: str(a["query"], "what was I working on"),
          cwd: str(a["cwd"], serverCwd),
          format: "narrative",
          limit: 20,
          safe_only: true, // Verified Recall: never resume stale memory
          ...(typeof a["token_budget"] === "number"
            ? { token_budget: a["token_budget"] }
            : { token_budget: 2000 }),
        }),
    },
    {
      name: "memory_remember",
      description:
        "Save a memory so any agent can recall it later. Persisted to the local memwarden store.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The content to remember" },
          sessionId: { type: "string", description: "Optional session id" },
          project: {
            type: "string",
            description:
              "Optional project directory. Defaults to where this server was launched (the current project).",
          },
        },
        required: ["text"],
      },
      // Scope to the server's launch directory by default — a memory saved
      // under a literal "mcp" project would never be found by memory_resume
      // running from the real repository. The fallback sessionId is scoped
      // to the same project (see projectScopedSessionId) so remembers from
      // two projects never share one session.
      call: (a) => {
        const project = str(a["project"], serverCwd);
        return api("POST", "/memwarden/observe", {
          hookType: "post_tool_use",
          sessionId: str(a["sessionId"], projectScopedSessionId("mcp", project)),
          project,
          cwd: project,
          timestamp: new Date().toISOString(),
          data: {
            tool_name: "memory_remember",
            tool_input: { text: str(a["text"]) },
            tool_output: str(a["text"]),
          },
        });
      },
    },
    {
      name: "memory_search",
      description:
        "Search memories by meaning and keywords (TurboQuant vector + BM25 hybrid). Returns ranked matches. " +
        "Scoped to the current project unless all_projects is true.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for" },
          limit: { type: "number", description: "Max results (default 10)" },
          all_projects: {
            type: "boolean",
            description:
              "Search across every project instead of just this one (deliberate cross-repo lookup).",
          },
        },
        required: ["query"],
      },
      // Project-scoped by default: an unscoped search silently mixes other
      // repositories' memories into results. all_projects stays available
      // as the explicit escape hatch for deliberate cross-repo lookups.
      call: (a) =>
        api("POST", "/memwarden/search", {
          query: str(a["query"]),
          limit: typeof a["limit"] === "number" ? a["limit"] : 10,
          ...(a["all_projects"] === true ? {} : { cwd: serverCwd }),
        }),
    },
    {
      name: "memory_context",
      description:
        "Pack the most relevant prior memory for this project into a context block under a token budget.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional focus query" },
          cwd: { type: "string", description: "Working directory to scope to (defaults to this project)" },
          token_budget: { type: "number", description: "Optional token budget" },
        },
      },
      // Routes through the project-scoped narrative search rather than
      // /context (which needs a sessionId+project the MCP layer doesn't
      // have). Returns a packed, budgeted context block.
      call: (a) =>
        api("POST", "/memwarden/search", {
          query: str(a["query"], "relevant context for this project"),
          cwd: str(a["cwd"], serverCwd),
          format: "narrative",
          limit: 20,
          safe_only: true, // Verified Recall: never inject stale memory
          ...(typeof a["token_budget"] === "number"
            ? { token_budget: a["token_budget"] }
            : { token_budget: 2000 }),
        }),
    },
    {
      name: "dejafix_lookup",
      description:
        "Déjà Fix: before you try to fix an error, check if ANY agent (Claude, Codex, Cursor, …) already solved this exact error in THIS project. Paste the error message, stack trace, or failing-test output. Returns matching fixes that are still valid — each verified against the live repo (a fix whose files changed or vanished is suppressed, never surfaced) and badged 'verified current' or 'sourced, unverified'. Call this whenever you hit an error before debugging from scratch.",
      inputSchema: {
        type: "object",
        properties: {
          error_text: {
            type: "string",
            description:
              "The error message, stack trace, or failing-test output to look up.",
          },
          cwd: {
            type: "string",
            description:
              "Working directory to scope to. Defaults to where this server was launched (the current project).",
          },
        },
        required: ["error_text"],
      },
      call: (a) =>
        api("POST", "/memwarden/dejafix/lookup", {
          error_text: str(a["error_text"]),
          cwd: str(a["cwd"], serverCwd),
        }),
    },
    {
      name: "dejafix_record",
      description:
        "Déjà Fix: record how an error was resolved so any agent that hits it again can recall the fix. Provide the original error text and a short fix narrative; optionally a root cause and the files the fix touched (hashed now so stale fixes are auto-suppressed later). Call this right after you resolve a non-trivial error.",
      inputSchema: {
        type: "object",
        properties: {
          error_text: {
            type: "string",
            description: "The error message/stack trace that was resolved.",
          },
          fix: {
            type: "string",
            description: "Short narrative of the fix that resolved it.",
          },
          root_cause: {
            type: "string",
            description: "Optional one-line root cause.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Files the fix touched/relied on (relative to cwd). Hashed for drift detection.",
          },
          cwd: {
            type: "string",
            description:
              "Working directory to scope to. Defaults to where this server was launched.",
          },
        },
        required: ["error_text", "fix"],
      },
      call: (a) =>
        api("POST", "/memwarden/dejafix/record", {
          error_text: str(a["error_text"]),
          fix: str(a["fix"]),
          ...(typeof a["root_cause"] === "string" && a["root_cause"]
            ? { root_cause: a["root_cause"] }
            : {}),
          ...(Array.isArray(a["files"])
            ? {
                files: (a["files"] as unknown[]).filter(
                  (f): f is string => typeof f === "string",
                ),
              }
            : {}),
          cwd: str(a["cwd"], serverCwd),
        }),
    },
    {
      name: "memory_verify",
      description:
        "Check the oplog hash chain is intact: tamper-EVIDENT integrity. Detects edits and reorders within the memory log (not tamper-proof: there is no signing yet, and truncating the newest entries is not detectable).",
      inputSchema: { type: "object", properties: {} },
      call: () => api("GET", "/memwarden/verify"),
    },
    {
      name: "memory_stats",
      description:
        "Report memory counts, the active embedding model, and the live TurboQuant compression ratio.",
      inputSchema: { type: "object", properties: {} },
      call: () => api("GET", "/memwarden/stats"),
    },
  ];

  const toolByName = new Map(tools.map((t) => [t.name, t]));

  // MCP prompts. Clients surface these as slash commands; `recall` is the
  // on-demand "pull my memory into this chat" command the whole layer is for.
  const prompts = [
    {
      name: "recall",
      description:
        "Pull relevant memory from past sessions into THIS chat. Give it what you're working on (e.g. 'the auth refactor'); it searches your memwarden brain — scoped to the current project — and injects the matching context.",
      arguments: [
        {
          name: "query",
          description:
            "What to recall (e.g. 'auth refactor', 'the proxy work'). Optional — omit to resume the project broadly.",
          required: false,
        },
      ],
    },
  ];

  async function recallText(query: string): Promise<string> {
    try {
      const result = (await api("POST", "/memwarden/search", {
        query,
        cwd: serverCwd,
        format: "narrative",
        limit: 20,
        token_budget: 2000,
        safe_only: true, // Verified Recall: /recall never injects stale memory
      })) as { text?: string };
      return typeof result.text === "string" ? result.text : "";
    } catch {
      return "";
    }
  }

  function ok(id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }
  function fail(
    id: JsonRpcResponse["id"],
    code: number,
    message: string,
  ): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  // Returns the response, or null for notifications (no id / initialized).
  async function dispatch(
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    switch (req.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case "notifications/initialized":
      case "initialized":
        return null;
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "prompts/list":
        return ok(id, { prompts });
      case "prompts/get": {
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (params.name !== "recall") {
          return fail(id, -32602, `unknown prompt: ${params.name}`);
        }
        const query = str(
          params.arguments?.["query"],
          "what was I working on in this project",
        );
        const text = await recallText(query);
        // Same shared framing + delimiter defense as every other injection
        // surface: recalled content is DATA, and an embedded closing marker
        // cannot break out of the block.
        const body = text
          ? `Relevant memory recalled by memwarden (scoped to this project) for "${query}".\n` +
            frameMemoryBlock(text)
          : `No relevant memory found for "${query}".`;
        return ok(id, {
          description: `memwarden recall: ${query}`,
          messages: [{ role: "user", content: { type: "text", text: body } }],
        });
      }
      case "tools/call": {
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const tool = params.name ? toolByName.get(params.name) : undefined;
        if (!tool) return fail(id, -32602, `unknown tool: ${params.name}`);
        try {
          const result = await tool.call(params.arguments ?? {});
          return ok(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          return ok(id, {
            isError: true,
            content: [
              {
                type: "text",
                text: `memory tool error: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          });
        }
      }
      default:
        if (id === null) return null; // unknown notification
        return fail(id, -32601, `method not found: ${req.method}`);
    }
  }

  return {
    dispatch,
    toolNames: () => tools.map((t) => t.name),
    promptNames: () => prompts.map((p) => p.name),
  };
}

export type McpServer = ReturnType<typeof createMcpServer>;

/**
 * Wire a server to newline-delimited JSON-RPC over stdin/stdout. Kept thin
 * and separate from dispatch() so the protocol logic stays testable.
 */
export function runStdio(server: McpServer): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        continue;
      }
      void server.dispatch(req).then((res) => {
        if (res) process.stdout.write(JSON.stringify(res) + "\n");
      });
    }
  });
}
