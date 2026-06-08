//
// End-to-end test: observe / context / search over the wire. Boots the FULL
// stack the way src/index.ts does — kernel + StoreLibsql(:memory:) + the
// registerCoreFunctions /
// registerApiTriggers wiring + a real node:http server on an EPHEMERAL port
// (port 0) — and exercises the canonical /memwarden/* REST contract over the
// wire with fetch():
//
// 1. POST /memwarden/observe  -> 201, { observationId: "obs_..." }
// 2. POST /memwarden/search   -> 200, BM25 finds the observation just
// written (results[0].observation.title)
// 3. POST /memwarden/context  -> 200, returns the prior session's
// observation packed under a token budget
//
// The assertions pin the WIRE SHAPES (status codes, body keys, value types)
// the contract guarantees, not just internal returns. Everything goes through
// the HTTP front door + the auth middleware chain, so this proves the layers
// compose.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerWorker,
  startHttpServer,
  __resetKernelSingleton,
  type Kernel,
  type RunningHttpServer,
} from "../src/kernel/index.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  registerCoreFunctions,
  getSearchIndex,
} from "../src/functions/index.js";
import { registerApiTriggers } from "../src/triggers/api.js";

let sdk: Kernel;
let store: StoreLibsql;
let http: RunningHttpServer;
let base: string;

beforeEach(async () => {
  __resetKernelSingleton();
  // The BM25 index is a module singleton; clear it so each boot starts cold,
  // exactly like a fresh process.
  getSearchIndex().clear();

  store = new StoreLibsql({ url: ":memory:" });
  sdk = registerWorker("in-process", { workerName: "memwarden-e2e" }, { store });
  // Same wiring the boot entrypoint performs.
  const kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  registerApiTriggers(sdk);

  // Ephemeral port: 0 lets the OS assign a free one. Read it back off the
  // listening socket.
  http = startHttpServer(sdk, { port: 0 });
  await waitForListening(http);
  const addr = http.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  expect(port).toBeGreaterThan(0);
  base = `http://127.0.0.1:${port}/memwarden`;
});

afterEach(async () => {
  await http.close().catch(() => undefined);
  await sdk.shutdown();
  __resetKernelSingleton();
});

function waitForListening(server: RunningHttpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (server.server.listening) {
      resolve();
      return;
    }
    server.server.once("listening", () => resolve());
  });
}

function observePayload(over: Record<string, unknown> = {}) {
  return {
    hookType: "post_tool_use",
    sessionId: "sess-e2e",
    project: "proj-e2e",
    cwd: "/work/proj-e2e",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Grep",
      tool_input: { pattern: "authentication", path: "src/auth.ts" },
      tool_output: "found 3 matches for authentication middleware in src/auth.ts",
    },
    ...over,
  };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("E2E: boot -> observe -> search (BM25) -> context over the REST wire", () => {
  it("livez answers 200 with the service identity (no auth)", async () => {
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", service: "memwarden" });
  });

  it("POST /observe persists an observation and returns 201 { observationId }", async () => {
    const res = await postJson("/observe", observePayload());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { observationId?: string };
    expect(body.observationId).toMatch(/^obs_/);

    // It actually persisted: the libSQL store has it under the session scope.
    const obs = await store.list(KV.observations("sess-e2e"));
    expect(obs).toHaveLength(1);
    // And the session row was created with observationCount = 1.
    const session = await store.get<{ observationCount: number; project: string }>(
      KV.sessions,
      "sess-e2e",
    );
    expect(session).toMatchObject({ observationCount: 1, project: "proj-e2e" });
  });

  it("POST /search (BM25) finds the observation written by /observe", async () => {
    const observed = await postJson("/observe", observePayload());
    expect(observed.status).toBe(201);

    const res = await postJson("/search", { query: "authentication" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      format: string;
      truncated: boolean;
      results: Array<{
        observation: { id: string; title: string };
        score: number;
        sessionId: string;
      }>;
    };
    // Wire-shape contract for the default (full) format.
    expect(body.format).toBe("full");
    expect(Array.isArray(body.results)).toBe(true);
    expect(typeof body.truncated).toBe("boolean");

    // BM25 found it.
    expect(body.results.length).toBeGreaterThan(0);
    const top = body.results[0]!;
    expect(top.observation.title).toBe("Grep");
    expect(top.sessionId).toBe("sess-e2e");
    expect(typeof top.score).toBe("number");
    expect(top.observation.id).toMatch(/^obs_/);
  });

  it("POST /search honors a token budget and reports it on the wire", async () => {
    await postJson("/observe", observePayload());

    const res = await postJson("/search", {
      query: "authentication",
      format: "compact",
      token_budget: 40,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      tokens_used: number;
      tokens_budget: number;
      truncated: boolean;
      results: unknown[];
    };
    expect(body.format).toBe("compact");
    expect(body.tokens_budget).toBe(40);
    expect(typeof body.tokens_used).toBe("number");
    // The budget is respected: usage never exceeds the declared budget.
    expect(body.tokens_used).toBeLessThanOrEqual(40);
    expect(typeof body.truncated).toBe("boolean");
  });

  it("POST /context returns a prior session's observation packed under a budget", async () => {
    // Seed a DIFFERENT, completed session in the same project with an
    // important observation. context excludes the current session, so it
    // surfaces this one.
    await store.set(KV.sessions, "sess-prior", {
      id: "sess-prior",
      project: "proj-e2e",
      cwd: "/work/proj-e2e",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      status: "completed",
      observationCount: 1,
    });
    await store.set(KV.observations("sess-prior"), "obs_imp_1", {
      id: "obs_imp_1",
      sessionId: "sess-prior",
      timestamp: new Date().toISOString(),
      type: "decision",
      title: "Chose libSQL for persistence",
      facts: [],
      narrative: "Picked libSQL over flat-file KV so list-by-scope is an index lookup.",
      concepts: [],
      files: [],
      importance: 8,
    });

    const res = await postJson("/context", {
      sessionId: "sess-current",
      project: "proj-e2e",
      budget: 4000,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      context: string;
      blocks: number;
      tokens: number;
    };
    // Wire-shape contract.
    expect(typeof body.context).toBe("string");
    expect(typeof body.blocks).toBe("number");
    expect(typeof body.tokens).toBe("number");

    // It returned the prior observation, packed under the budget.
    expect(body.blocks).toBeGreaterThan(0);
    expect(body.tokens).toBeGreaterThan(0);
    expect(body.tokens).toBeLessThanOrEqual(4000);
    expect(body.context).toContain('<memwarden-context project="proj-e2e">');
    expect(body.context).toContain("Chose libSQL for persistence");
  });

  it("rejects malformed input with 400 (observe missing fields / search empty query)", async () => {
    const badObserve = await postJson("/observe", { hookType: "post_tool_use" });
    expect(badObserve.status).toBe(400);

    const badSearch = await postJson("/search", { query: "   " });
    expect(badSearch.status).toBe(400);

    const badContext = await postJson("/context", { sessionId: "x" });
    expect(badContext.status).toBe(400);
  });

  it("404s an unknown route and answers CORS preflight with 204", async () => {
    const missing = await fetch(`${base}/does-not-exist`);
    expect(missing.status).toBe(404);

    const preflight = await fetch(`${base}/observe`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3113" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3113",
    );
  });

  it("full round trip: observe then search then context all succeed in one boot", async () => {
    // observe
    const o = await postJson("/observe", observePayload());
    expect(o.status).toBe(201);

    // search finds it
    const s = await postJson("/search", { query: "middleware", project: "proj-e2e" });
    expect(s.status).toBe(200);
    const searched = (await s.json()) as { results: unknown[] };
    expect(searched.results.length).toBeGreaterThan(0);

    // context for the SAME session returns empty (its own observation is
    // excluded, and there is no other session) — contract: { context:"",
    // blocks:0, tokens:0 }.
    const c = await postJson("/context", {
      sessionId: "sess-e2e",
      project: "proj-e2e",
    });
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ context: "", blocks: 0, tokens: 0 });
  });
});
