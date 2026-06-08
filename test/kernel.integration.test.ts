//
// End-to-end: kernel + StoreLibsql (in-memory libSQL) + HTTP. Proves a
// write-path route persists through the state::* built-ins and a
// read-path route lists it back, that 201 status is preserved, and that
// a type:"state" trigger fires off the store mutation event the kernel
// subscribes to. This is the closest stand-in for the
// observe -> kv.set -> session-count-changed flow.

import { afterEach, describe, expect, it } from "vitest";
import {
  registerWorker,
  startHttpServer,
  TriggerAction,
  __resetKernelSingleton,
} from "../src/kernel/index.js";
import { StoreLibsql } from "../src/state/store-libsql.js";

afterEach(() => __resetKernelSingleton());

describe("kernel + StoreLibsql + HTTP end to end", () => {
  it("persists via state::set through an HTTP route and lists it back; fires the state trigger", async () => {
    const store = new StoreLibsql({ url: ":memory:" });
    const sdk = registerWorker(
      "in-process",
      { workerName: "memwarden-it" },
      { store },
    );

    const stateEvents: Array<{ key: string; event_type: string }> = [];
    sdk.registerFunction(
      "event::session::observation-count-changed",
      async (e: { key: string; event_type: string }) => {
        stateEvents.push(e);
      },
    );
    sdk.registerTrigger({
      type: "state",
      function_id: "event::session::observation-count-changed",
      config: { scope: "mem:sessions" },
    });

    // Write path: POST /observe -> state::set under mem:sessions, 201.
    sdk.registerFunction(
      "api::observe",
      async (req: { body?: { sessionId?: string } }) => {
        const sessionId = req.body?.sessionId ?? "unknown";
        await sdk.trigger({
          function_id: "state::set",
          payload: {
            scope: "mem:sessions",
            key: sessionId,
            value: { id: sessionId, observationCount: 1 },
          },
        });
        // fire-and-forget viewer stream (must not throw)
        sdk.trigger({
          function_id: "stream::send",
          payload: { stream_name: "mem-live", id: `raw-${sessionId}` },
          action: TriggerAction.Void(),
        });
        return { status_code: 201, body: { observationId: sessionId } };
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

    // Read path: GET /sessions -> state::list.
    sdk.registerFunction("api::sessions", async () => {
      const sessions = await sdk.trigger({
        function_id: "state::list",
        payload: { scope: "mem:sessions" },
      });
      return { status_code: 200, body: { sessions } };
    });
    sdk.registerTrigger({
      type: "http",
      function_id: "api::sessions",
      config: { api_path: "/memwarden/sessions", http_method: "GET" },
    });

    // Open auth (no secret configured).
    sdk.registerFunction("middleware::api-auth", async () => ({
      action: "continue",
    }));

    const http = startHttpServer(sdk, { port: 0 });
    await new Promise((r) => setTimeout(r, 30));
    const addr = http.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const post = await fetch(`http://127.0.0.1:${port}/memwarden/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-1" }),
      });
      expect(post.status).toBe(201);
      expect(await post.json()).toEqual({ observationId: "sess-1" });

      const get = await fetch(`http://127.0.0.1:${port}/memwarden/sessions`);
      expect(get.status).toBe(200);
      expect(await get.json()).toEqual({
        sessions: [{ id: "sess-1", observationCount: 1 }],
      });

      // The state mutation under mem:sessions drives the type:"state" trigger.
      await new Promise((r) => setTimeout(r, 20));
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0]).toMatchObject({ key: "sess-1", event_type: "set" });
    } finally {
      await http.close();
      await sdk.shutdown();
    }
  });
});
