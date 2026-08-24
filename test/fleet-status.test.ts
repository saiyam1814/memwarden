//
// Fleet status REST route (#26): POST /memwarden/fleet/status returns the
// agents active in a project, fed by the registry that mem::observe upserts.
// Boots the real HTTP stack on an ephemeral port (same harness discipline as
// test/http-security.test.ts) so the route, middleware wiring, and JSON
// contract are all exercised as production sees them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  registerWorker,
  startHttpServer,
  __resetKernelSingleton,
  type Kernel,
  type RunningHttpServer,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import {
  registerCoreFunctions,
  getSearchIndex,
} from "../src/functions/index.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { FleetAgent } from "../src/functions/fleet.js";

let sdk: Kernel;
let http: RunningHttpServer;
let port: number;

beforeEach(async () => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-fleet-http" }, {
    store: new StoreMemory(),
  });
  const kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  registerApiTriggers(sdk);
  http = startHttpServer(sdk, { port: 0 });
  await new Promise<void>((resolve) => {
    if (http.server.listening) resolve();
    else http.server.once("listening", () => resolve());
  });
  const addr = http.server.address() as AddressInfo;
  port = addr.port;
});

afterEach(async () => {
  await http.close().catch(() => undefined);
  await sdk.shutdown();
  __resetKernelSingleton();
});

function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            json: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function capture(sessionId: string, cwd: string, agent: string, file: string) {
  return sdk.trigger({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId,
      project: cwd,
      cwd,
      timestamp: new Date().toISOString(),
      agent,
      data: {
        tool_name: "Edit",
        tool_input: { file_path: file },
        tool_output: "ok",
      },
    },
  });
}

describe("POST /memwarden/fleet/status", () => {
  it("returns the agents active in the requested project", async () => {
    const cwd = "/tmp/memwarden-fleet-http-a";
    await capture("s1", cwd, "claude-code", "src/a.ts");
    await capture("s2", cwd, "cursor", "src/b.ts");
    await capture("elsewhere", "/tmp/memwarden-fleet-http-b", "codex", "x.ts");

    const r = await post("/memwarden/fleet/status", { project: cwd });
    expect(r.status).toBe(200);
    const body = r.json as { project: string; agents: FleetAgent[] };
    expect(body.project).toBe(cwd);
    expect(body.agents.map((a) => a.sessionId).sort()).toEqual(["s1", "s2"]);
    const s1 = body.agents.find((a) => a.sessionId === "s1");
    expect(s1?.host).toBe("claude-code");
    expect(s1?.files).toContain("src/a.ts");
    expect(s1?.captureCount).toBe(1);
  });

  it("rejects a request without a project", async () => {
    const r = await post("/memwarden/fleet/status", {});
    expect(r.status).toBe(400);
  });

  it("honors within_ms as the recency window", async () => {
    const cwd = "/tmp/memwarden-fleet-http-c";
    await capture("s1", cwd, "claude-code", "src/a.ts");
    // A 1ms window has already elapsed by the time the request lands.
    await new Promise((res) => setTimeout(res, 5));
    const r = await post("/memwarden/fleet/status", {
      project: cwd,
      within_ms: 1,
    });
    expect(r.status).toBe(200);
    expect((r.json as { agents: FleetAgent[] }).agents).toEqual([]);
  });
});
