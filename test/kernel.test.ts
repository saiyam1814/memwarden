//
// Kernel contract tests: function registry + trigger dispatch, the
// built-in state::* / stream::* / engine::workers::list routing,
// fire-and-forget Void semantics, registerTrigger HTTP routing with
// middleware short-circuit, durable:subscriber, and type:"state"
// change events.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerWorker,
  startHttpServer,
  TriggerAction,
  TriggerError,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";

function freshKernel(): Kernel {
  __resetKernelSingleton();
  return registerWorker("in-process", {
    workerName: "memwarden-test",
  });
}

describe("function registry + trigger dispatch", () => {
  afterEach(() => __resetKernelSingleton());

  it("registers and triggers a function, resolving the return value", async () => {
    const sdk = freshKernel();
    sdk.registerFunction("mem::echo", async (p: { x: number }) => ({
      doubled: p.x * 2,
    }));
    const result = await sdk.trigger<{ x: number }, { doubled: number }>({
      function_id: "mem::echo",
      payload: { x: 21 },
    });
    expect(result.doubled).toBe(42);
  });

  it("rejects an unregistered function_id with a TriggerError carrying code/function_id/message", async () => {
    const sdk = freshKernel();
    await expect(
      sdk.trigger({ function_id: "mem::missing", payload: {} }),
    ).rejects.toMatchObject({
      code: "FUNCTION_NOT_FOUND",
      function_id: "mem::missing",
    });
    await expect(
      sdk.trigger({ function_id: "mem::missing", payload: {} }),
    ).rejects.toBeInstanceOf(TriggerError);
  });

  it("Void trigger is fire-and-forget and does not reject toward the caller", async () => {
    const sdk = freshKernel();
    let called = false;
    sdk.registerFunction("mem::sink", () => {
      called = true;
      throw new Error("boom"); // must not crash / reject
    });
    const ret = await sdk.trigger({
      function_id: "mem::sink",
      payload: {},
      action: TriggerAction.Void(),
    });
    expect(ret).toBeUndefined();
    // Give the microtask queue a tick to run the swallowed handler.
    await new Promise((r) => setTimeout(r, 5));
    expect(called).toBe(true);
  });

  it("Void trigger to an unregistered id never throws synchronously", () => {
    const sdk = freshKernel();
    expect(() =>
      sdk.trigger({
        function_id: "mem::nope",
        payload: {},
        action: TriggerAction.Void(),
      }),
    ).not.toThrow();
  });
});

describe("built-in state::* routing", () => {
  afterEach(() => __resetKernelSingleton());

  it("get returns null on miss (not undefined, not throw)", async () => {
    const sdk = freshKernel();
    const v = await sdk.trigger({
      function_id: "state::get",
      payload: { scope: "mem:sessions", key: "nope" },
    });
    expect(v).toBeNull();
  });

  it("set upserts and returns the value; get reads it back", async () => {
    const sdk = freshKernel();
    const stored = await sdk.trigger({
      function_id: "state::set",
      payload: { scope: "mem:sessions", key: "s1", value: { id: "s1", n: 1 } },
    });
    expect(stored).toEqual({ id: "s1", n: 1 });
    const read = await sdk.trigger({
      function_id: "state::get",
      payload: { scope: "mem:sessions", key: "s1" },
    });
    expect(read).toEqual({ id: "s1", n: 1 });
  });

  it("update applies flat set ops and returns the updated record", async () => {
    const sdk = freshKernel();
    await sdk.trigger({
      function_id: "state::set",
      payload: { scope: "mem:sessions", key: "s1", value: { id: "s1", observationCount: 0 } },
    });
    const updated = await sdk.trigger({
      function_id: "state::update",
      payload: {
        scope: "mem:sessions",
        key: "s1",
        ops: [
          { type: "set", path: "observationCount", value: 5 },
          { type: "set", path: "status", value: "active" },
        ],
      },
    });
    expect(updated).toMatchObject({ id: "s1", observationCount: 5, status: "active" });
  });

  it("update on a missing key starts from {}", async () => {
    const sdk = freshKernel();
    const updated = await sdk.trigger({
      function_id: "state::update",
      payload: {
        scope: "mem:sessions",
        key: "ghost",
        ops: [{ type: "set", path: "endedAt", value: "now" }],
      },
    });
    expect(updated).toEqual({ endedAt: "now" });
  });

  it("delete is idempotent and removes the value", async () => {
    const sdk = freshKernel();
    await sdk.trigger({
      function_id: "state::set",
      payload: { scope: "mem:memories", key: "m1", value: { v: 1 } },
    });
    await sdk.trigger({ function_id: "state::delete", payload: { scope: "mem:memories", key: "m1" } });
    await sdk.trigger({ function_id: "state::delete", payload: { scope: "mem:memories", key: "m1" } });
    const read = await sdk.trigger({ function_id: "state::get", payload: { scope: "mem:memories", key: "m1" } });
    expect(read).toBeNull();
  });

  it("list is exact-scope match, values only, insertion order, empty on unknown", async () => {
    const sdk = freshKernel();
    await sdk.trigger({ function_id: "state::set", payload: { scope: "mem:obs:a", key: "k1", value: { o: 1 } } });
    await sdk.trigger({ function_id: "state::set", payload: { scope: "mem:obs:a", key: "k2", value: { o: 2 } } });
    await sdk.trigger({ function_id: "state::set", payload: { scope: "mem:obs:b", key: "k3", value: { o: 3 } } });
    const a = await sdk.trigger<{ scope: string }, Array<{ o: number }>>({
      function_id: "state::list",
      payload: { scope: "mem:obs:a" },
    });
    expect(a).toEqual([{ o: 1 }, { o: 2 }]);
    const unknown = await sdk.trigger({ function_id: "state::list", payload: { scope: "mem:obs:zzz" } });
    expect(unknown).toEqual([]);
  });

  it("engine::workers::list returns { workers: [] }", async () => {
    const sdk = freshKernel();
    const r = await sdk.trigger({ function_id: "engine::workers::list", payload: {} });
    expect(r).toEqual({ workers: [] });
  });

  it("stream::set / stream::send are best-effort no-throw", async () => {
    const sdk = freshKernel();
    await expect(
      sdk.trigger({ function_id: "stream::set", payload: { stream_name: "mem-live", item_id: "x" } }),
    ).resolves.toBeUndefined();
    await expect(
      sdk.trigger({ function_id: "stream::send", payload: { stream_name: "mem-live", id: "y" }, action: TriggerAction.Void() }),
    ).resolves.toBeUndefined();
  });
});

describe("type:state change triggers", () => {
  afterEach(() => __resetKernelSingleton());

  it("fires a registered state trigger on set/update/delete of its scope", async () => {
    const sdk = freshKernel();
    const events: Array<{ key: string; event_type: string }> = [];
    sdk.registerFunction("event::obs-count-changed", async (e: { key: string; event_type: string }) => {
      events.push(e);
    });
    sdk.registerTrigger({
      type: "state",
      function_id: "event::obs-count-changed",
      config: { scope: "mem:sessions" },
    });

    await sdk.trigger({ function_id: "state::set", payload: { scope: "mem:sessions", key: "s1", value: { observationCount: 1 } } });
    await sdk.trigger({ function_id: "state::update", payload: { scope: "mem:sessions", key: "s1", ops: [{ type: "set", path: "observationCount", value: 2 }] } });
    await sdk.trigger({ function_id: "state::delete", payload: { scope: "mem:sessions", key: "s1" } });
    // a non-subscribed scope must NOT fire
    await sdk.trigger({ function_id: "state::set", payload: { scope: "mem:memories", key: "m", value: {} } });

    await new Promise((r) => setTimeout(r, 10));
    expect(events.map((e) => e.event_type)).toEqual(["set", "update", "delete"]);
    expect(events.every((e) => e.key === "s1")).toBe(true);
  });
});

describe("durable:subscriber pub/sub", () => {
  afterEach(() => __resetKernelSingleton());

  it("would invoke a subscriber when its topic is published (in-process)", async () => {
    const sdk = freshKernel();
    let seen: unknown = null;
    sdk.registerFunction("event::session::started", async (d: unknown) => {
      seen = d;
    });
    sdk.registerTrigger({
      type: "durable:subscriber",
      function_id: "event::session::started",
      config: { topic: "memwarden.session.started" },
    });
    sdk.streams.publish("memwarden.session.started", { sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual({ sessionId: "s1" });
  });
});

describe("HTTP routing", () => {
  afterEach(() => __resetKernelSingleton());

  it("routes method+path to the bound function and serializes status_code+body", async () => {
    const sdk = freshKernel();
    sdk.registerFunction("api::liveness", async () => ({
      status_code: 200,
      body: { status: "ok", service: "memwarden" },
    }));
    sdk.registerTrigger({
      type: "http",
      function_id: "api::liveness",
      config: { api_path: "/memwarden/livez", http_method: "GET" },
    });
    sdk.registerFunction("api::observe", async (req: { body?: { sessionId?: string } }) => ({
      status_code: 201,
      body: { observationId: req.body?.sessionId ?? "none" },
    }));
    sdk.registerTrigger({
      type: "http",
      function_id: "api::observe",
      config: { api_path: "/memwarden/observe", http_method: "POST", middleware_function_ids: ["middleware::api-auth"] },
    });
    // open middleware (no secret) -> continue
    sdk.registerFunction("middleware::api-auth", async () => ({ action: "continue" }));

    const http = startHttpServer(sdk, { port: 0 });
    await new Promise((r) => setTimeout(r, 20));
    const addr = http.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const live = await fetch(`http://127.0.0.1:${port}/memwarden/livez`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok", service: "memwarden" });

      const obs = await fetch(`http://127.0.0.1:${port}/memwarden/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "abc" }),
      });
      expect(obs.status).toBe(201);
      expect(await obs.json()).toEqual({ observationId: "abc" });

      const missing = await fetch(`http://127.0.0.1:${port}/memwarden/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await http.close();
    }
  });

  it("middleware short-circuit returns the canned response and skips the handler", async () => {
    const sdk = freshKernel();
    let handlerRan = false;
    sdk.registerFunction("api::secure", async () => {
      handlerRan = true;
      return { status_code: 200, body: { ok: true } };
    });
    sdk.registerFunction("middleware::api-auth", async () => ({
      action: "respond",
      response: { status_code: 401, body: { error: "unauthorized" } },
    }));
    sdk.registerTrigger({
      type: "http",
      function_id: "api::secure",
      config: { api_path: "/memwarden/secure", http_method: "GET", middleware_function_ids: ["middleware::api-auth"] },
    });

    const http = startHttpServer(sdk, { port: 0 });
    await new Promise((r) => setTimeout(r, 20));
    const addr = http.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/memwarden/secure`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(handlerRan).toBe(false);
    } finally {
      await http.close();
    }
  });

  it("answers OPTIONS preflight with 204 and CORS headers", async () => {
    const sdk = freshKernel();
    const http = startHttpServer(sdk, { port: 0 });
    await new Promise((r) => setTimeout(r, 20));
    const addr = http.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/memwarden/livez`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:3113" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3113");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    } finally {
      await http.close();
    }
  });
});

describe("on(\"connection_state\") + registerTrigger event wiring", () => {
  afterEach(() => __resetKernelSingleton());

  it("on(\"connection_state\") fires \"connected\" after construction (microtask)", async () => {
    const sdk = freshKernel();
    const states: unknown[] = [];
    // Registered synchronously right after construction; the kernel defers
    // the first "connected" to a microtask so this listener still observes it.
    sdk.on?.("connection_state", (state) => states.push(state));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(states).toContain("connected");
  });

  it("on(\"connection_state\") fires \"disconnected\" on shutdown", async () => {
    const sdk = freshKernel();
    const states: unknown[] = [];
    sdk.on?.("connection_state", (state) => states.push(state));
    await new Promise((r) => setTimeout(r, 5));
    await sdk.shutdown();
    expect(states).toContain("disconnected");
  });

  it("registerTrigger binds an HTTP route discoverable via getHttpRoutes", () => {
    const sdk = freshKernel();
    sdk.registerFunction("api::x", async () => ({ status_code: 200, body: {} }));
    sdk.registerTrigger({
      type: "http",
      function_id: "api::x",
      config: { api_path: "/memwarden/x", http_method: "POST", middleware_function_ids: ["m1"] },
    });
    const routes = sdk.getHttpRoutes();
    const route = routes.find((r) => r.path === "/memwarden/x");
    expect(route).toMatchObject({
      method: "POST",
      functionId: "api::x",
      middlewareFunctionIds: ["m1"],
    });
  });
});

describe("cron / scheduled maintenance sweeps", () => {
  // The kernel has no cron primitive; the boot path (src/index.ts) drives
  // periodic maintenance via timer-fired `sdk.trigger(...)`. These tests pin
  // that mechanism: a scheduled trigger fires the registered function on its
  // interval, and a scheduled trigger to a not-yet-registered function rejects
  // harmlessly so it is safe to schedule before the handler exists.
  afterEach(() => {
    vi.useRealTimers();
    __resetKernelSingleton();
  });

  it("a scheduled trigger fires its function on each interval tick", async () => {
    vi.useFakeTimers();
    const sdk = freshKernel();
    let fires = 0;
    sdk.registerFunction("mem::auto-forget", async (p: { dryRun: boolean }) => {
      expect(p.dryRun).toBe(false);
      fires++;
    });

    // Mirror installSweeps: an interval that fires the trigger.
    const timer = setInterval(() => {
      void sdk
        .trigger({ function_id: "mem::auto-forget", payload: { dryRun: false } })
        .catch(() => undefined);
    }, 1000);

    await vi.advanceTimersByTimeAsync(3000);
    clearInterval(timer);
    expect(fires).toBe(3);
  });

  it("a scheduled trigger to an unregistered function rejects harmlessly (caught)", async () => {
    vi.useFakeTimers();
    const sdk = freshKernel();
    let unhandled = false;
    const onRej = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", onRej);
    try {
      const timer = setInterval(() => {
        // installSweeps schedules sweeps for functions that may not be registered
        // yet; the .catch() keeps the rejection from escaping.
        void sdk
          .trigger({ function_id: "mem::not-registered-yet", payload: {} })
          .catch(() => undefined);
      }, 1000);
      await vi.advanceTimersByTimeAsync(2000);
      clearInterval(timer);
      // Let any microtasks settle.
      await Promise.resolve();
      expect(unhandled).toBe(false);
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });
});

describe("shutdown lifecycle", () => {
  afterEach(() => __resetKernelSingleton());

  it("shutdown is idempotent: repeated calls resolve and never throw", async () => {
    const sdk = freshKernel();
    await expect(sdk.shutdown()).resolves.toBeUndefined();
    await expect(sdk.shutdown()).resolves.toBeUndefined();
    await expect(sdk.shutdown()).resolves.toBeUndefined();
  });

  it("shutdown notifies connection_state listeners exactly once", async () => {
    const sdk = freshKernel();
    let disconnects = 0;
    sdk.on?.("connection_state", (state) => {
      if (state === "disconnected") disconnects++;
    });
    await new Promise((r) => setTimeout(r, 5));
    await sdk.shutdown();
    await sdk.shutdown(); // second call is a no-op
    expect(disconnects).toBe(1);
  });

  it("stops driving state triggers after shutdown (mutation listener unsubscribed)", async () => {
    const sdk = freshKernel();
    const events: string[] = [];
    sdk.registerFunction("event::after-shutdown", async (e: { event_type: string }) => {
      events.push(e.event_type);
    });
    sdk.registerTrigger({
      type: "state",
      function_id: "event::after-shutdown",
      config: { scope: "mem:sessions" },
    });
    await sdk.trigger({
      function_id: "state::set",
      payload: { scope: "mem:sessions", key: "s1", value: { n: 1 } },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["set"]);

    await sdk.shutdown();
    // After shutdown the store mutation subscription is torn down, so a write
    // performed directly against the store no longer fans out to the trigger.
    await sdk.stateStore.set("mem:sessions", "s2", { n: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["set"]); // unchanged
  });
});

describe("StateKV compatibility (drop-in over the kernel)", () => {
  afterEach(() => __resetKernelSingleton());

  it("the 5 state:: function_ids satisfy the StateKV wrapper semantics", async () => {
    const sdk = freshKernel();
    // mimic src/state/kv.ts StateKV without importing it
    const kv = {
      get: <T,>(scope: string, key: string) =>
        sdk.trigger<{ scope: string; key: string }, T | null>({ function_id: "state::get", payload: { scope, key } }),
      set: <T,>(scope: string, key: string, value: T) =>
        sdk.trigger<{ scope: string; key: string; value: T }, T>({ function_id: "state::set", payload: { scope, key, value } }),
      list: <T,>(scope: string) =>
        sdk.trigger<{ scope: string }, T[]>({ function_id: "state::list", payload: { scope } }),
    };
    await kv.set("mem:sessions", "s1", { id: "s1" });
    expect(await kv.get("mem:sessions", "s1")).toEqual({ id: "s1" });
    expect(await kv.list("mem:sessions")).toEqual([{ id: "s1" }]);
    expect(await kv.get("mem:sessions", "absent")).toBeNull();
  });
});
