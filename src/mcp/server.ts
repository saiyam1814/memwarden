//
// Dependency-free MCP server for memwarden. A hand-rolled JSON-RPC 2.0
// dispatcher over stdio — no @modelcontextprotocol/sdk — so the core stays
// lean and self-contained, and the dispatcher is unit-testable without a
// host or a pipe. It proxies to a running memwarden daemon over HTTP, so
// every MCP client (Claude Code, Cursor, Claude Desktop, Cline, Windsurf)
// shares the one local brain.
//
// Beyond the usual save/search/context tools, it exposes the two memwarden
// has and others don't: memory_verify (cryptographic oplog integrity) and
// memory_stats (live TurboQuant compression ratio).

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "memwarden";
const SERVER_VERSION = "0.1.0";

export interface McpServerOptions {
  baseUrl: string; // e.g. http://localhost:3111
  secret?: string;
  fetchFn?: typeof fetch; // injectable for tests
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

  async function api(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.secret) headers["authorization"] = `Bearer ${opts.secret}`;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text, status: res.status };
    }
  }

  const tools: ToolDef[] = [
    {
      name: "memory_remember",
      description:
        "Save a memory so any agent can recall it later. Persisted to the local memwarden store.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The content to remember" },
          sessionId: { type: "string", description: "Optional session id" },
          project: { type: "string", description: "Optional project label" },
        },
        required: ["text"],
      },
      call: (a) =>
        api("POST", "/memwarden/observe", {
          hookType: "post_tool_use",
          sessionId: str(a["sessionId"], "mcp"),
          project: str(a["project"], "mcp"),
          cwd: str(a["project"], "mcp"),
          timestamp: new Date().toISOString(),
          data: {
            tool_name: "memory_remember",
            tool_input: { text: str(a["text"]) },
            tool_output: str(a["text"]),
          },
        }),
    },
    {
      name: "memory_search",
      description:
        "Search memories by meaning and keywords (TurboQuant vector + BM25 hybrid). Returns ranked matches.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
      call: (a) =>
        api("POST", "/memwarden/search", {
          query: str(a["query"]),
          limit: typeof a["limit"] === "number" ? a["limit"] : 10,
        }),
    },
    {
      name: "memory_context",
      description:
        "Pack the most relevant prior memory into a context block under a token budget.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional focus query" },
          token_budget: { type: "number", description: "Optional token budget" },
        },
      },
      call: (a) => {
        const body: Record<string, unknown> = {};
        if (typeof a["query"] === "string") body["query"] = a["query"];
        if (typeof a["token_budget"] === "number")
          body["token_budget"] = a["token_budget"];
        return api("POST", "/memwarden/context", body);
      },
    },
    {
      name: "memory_verify",
      description:
        "Cryptographically verify the memory store has not been tampered with (oplog hash-chain integrity).",
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
          capabilities: { tools: {} },
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

  return { dispatch, toolNames: () => tools.map((t) => t.name) };
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
