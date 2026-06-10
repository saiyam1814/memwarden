//
// Security firewall on the kernel HTTP front door. Boots the real stack (the
// same wiring src/index.ts uses) on an ephemeral port and drives it with raw
// node:http requests so we can forge the Host header and the Content-Type the
// way a malicious cross-origin client would. Pins the production contract:
//
//   - a non-loopback Host (DNS-rebinding) is rejected 403 BEFORE any handler,
//     so whole-brain exfil via GET /memwarden/export can't reach the data;
//   - a body-bearing POST without application/json is rejected 415 BEFORE the
//     body is parsed, killing the no-preflight cross-origin write to /observe
//     and /import (memory poisoning);
//   - a well-formed loopback + JSON request still works.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  registerWorker,
  startHttpServer,
  __resetKernelSingleton,
  type Kernel,
  type RunningHttpServer,
} from "../src/kernel/index.js";
import { isLoopbackHost } from "../src/kernel/http.js";
import { startProxyServer, type RunningProxy } from "../src/proxy/server.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { StateKV } from "../src/state/kv.js";
import {
  registerCoreFunctions,
  getSearchIndex,
} from "../src/functions/index.js";
import { registerApiTriggers } from "../src/triggers/api.js";

let sdk: Kernel;
let http: RunningHttpServer;
let port: number;

beforeEach(async () => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-http-sec" }, {
    store: new StoreLibsql({ url: ":memory:" }),
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

interface Raw {
  status: number;
  body: string;
}

// Raw request so we can forge Host / Content-Type independent of the socket we
// actually connect to (always 127.0.0.1).
function rawTo(
  toPort: number,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<Raw> {
  return new Promise<Raw>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: toPort,
        method: opts.method,
        path: opts.path,
        headers: opts.headers ?? {},
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// Convenience for the kernel server (module-scoped `port`).
function raw(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Raw> {
  return rawTo(port, opts);
}

const validObserve = JSON.stringify({
  hookType: "post_tool_use",
  sessionId: "s-sec",
  project: "proj-sec",
  cwd: "/work/proj-sec",
  timestamp: new Date().toISOString(),
  data: { tool_name: "Grep", tool_input: { pattern: "x" }, tool_output: "y" },
});

describe("Host-header DNS-rebinding guard", () => {
  it("rejects a non-loopback Host with 403 (and does not run the handler)", async () => {
    const res = await raw({
      method: "GET",
      path: "/memwarden/export",
      headers: { Host: "attacker.example.com" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("forbidden_host");
  });

  it("rejects a rebinding subdomain of localhost (127.0.0.1.attacker.com)", async () => {
    const res = await raw({
      method: "GET",
      path: "/memwarden/livez",
      headers: { Host: "127.0.0.1.attacker.com" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a loopback Host (127.0.0.1:port)", async () => {
    const res = await raw({
      method: "GET",
      path: "/memwarden/livez",
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("ok");
  });

  it("allows a localhost Host (case-insensitive)", async () => {
    const res = await raw({
      method: "GET",
      path: "/memwarden/livez",
      headers: { Host: `LOCALHOST:${port}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("Content-Type enforcement on writes", () => {
  it("rejects a body-bearing POST that is not application/json with 415", async () => {
    const res = await raw({
      method: "POST",
      path: "/memwarden/observe",
      headers: { Host: `127.0.0.1:${port}`, "Content-Type": "text/plain" },
      body: validObserve,
    });
    expect(res.status).toBe(415);
    expect(res.body).toContain("unsupported_media_type");
  });

  it("rejects a body-bearing POST with NO Content-Type with 415", async () => {
    const res = await raw({
      method: "POST",
      path: "/memwarden/observe",
      headers: { Host: `127.0.0.1:${port}` },
      body: validObserve,
    });
    expect(res.status).toBe(415);
  });

  it("accepts a well-formed loopback + application/json POST", async () => {
    const res = await raw({
      method: "POST",
      path: "/memwarden/observe",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: validObserve,
    });
    expect(res.status).toBe(201);
    expect(res.body).toContain("observationId");
  });

  it("accepts application/json with a charset parameter", async () => {
    const res = await raw({
      method: "POST",
      path: "/memwarden/observe",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: validObserve,
    });
    expect(res.status).toBe(201);
  });
});

describe("isLoopbackHost unit", () => {
  it("accepts loopback hosts with matching or absent port", () => {
    expect(isLoopbackHost("localhost:3111", 3111)).toBe(true);
    expect(isLoopbackHost("127.0.0.1:3111", 3111)).toBe(true);
    expect(isLoopbackHost("[::1]:3111", 3111)).toBe(true);
    expect(isLoopbackHost("localhost", 3111)).toBe(true);
    expect(isLoopbackHost("127.0.0.1", 3111)).toBe(true);
    expect(isLoopbackHost("127.0.0.1:3111", undefined)).toBe(true);
  });

  it("rejects non-loopback, port mismatch, and malformed hosts", () => {
    expect(isLoopbackHost("attacker.com:3111", 3111)).toBe(false);
    expect(isLoopbackHost("127.0.0.1.attacker.com:3111", 3111)).toBe(false);
    expect(isLoopbackHost("localhost:9999", 3111)).toBe(false);
    expect(isLoopbackHost(undefined, 3111)).toBe(false);
    expect(isLoopbackHost("", 3111)).toBe(false);
  });
});

describe("auth on verify/stats when a secret is set (livez stays open)", () => {
  let secSdk: Kernel;
  let secHttp: RunningHttpServer;
  let secPort: number;
  const SECRET = "test-secret-abc123";

  beforeEach(async () => {
    secSdk = registerWorker("in-process", { workerName: "memwarden-sec-auth" }, {
      store: new StoreLibsql({ url: ":memory:" }),
    });
    registerCoreFunctions(secSdk, new StateKV(secSdk));
    // Explicit secret so the api-auth middleware enforces it.
    registerApiTriggers(secSdk, SECRET);
    secHttp = startHttpServer(secSdk, { port: 0 });
    await new Promise<void>((resolve) => {
      if (secHttp.server.listening) resolve();
      else secHttp.server.once("listening", () => resolve());
    });
    secPort = (secHttp.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await secHttp.close().catch(() => undefined);
    await secSdk.shutdown();
  });

  function get(path: string, bearer?: string): Promise<Raw> {
    const headers: Record<string, string> = { Host: `127.0.0.1:${secPort}` };
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
    return rawTo(secPort, { method: "GET", path, headers });
  }

  it("livez stays open without auth", async () => {
    const res = await get("/memwarden/livez");
    expect(res.status).toBe(200);
  });

  it("verify is 401 without the secret, 200 with it", async () => {
    expect((await get("/memwarden/verify")).status).toBe(401);
    expect((await get("/memwarden/verify", SECRET)).status).toBe(200);
  });

  it("stats is 401 without the secret, 200 with it", async () => {
    expect((await get("/memwarden/stats")).status).toBe(401);
    expect((await get("/memwarden/stats", SECRET)).status).toBe(200);
  });
});

describe("proxy DNS-rebinding guard", () => {
  let proxy: RunningProxy;
  let proxyPort: number;

  beforeEach(async () => {
    proxy = startProxyServer({
      port: 0,
      // Upstream/daemon are never reached for the rejected/livez cases.
      upstreamUrl: "http://127.0.0.1:1/v1",
      daemonUrl: "http://127.0.0.1:1",
      project: "/repo",
      cwd: "/repo",
    });
    await once(proxy.server, "listening");
    proxyPort = (proxy.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await proxy.close().catch(() => undefined);
  });

  it("rejects a non-loopback Host with 403", async () => {
    const res = await rawTo(proxyPort, {
      method: "GET",
      path: "/livez",
      headers: { Host: "attacker.example.com" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("forbidden_host");
  });

  it("allows a loopback Host on /livez", async () => {
    const res = await rawTo(proxyPort, {
      method: "GET",
      path: "/livez",
      headers: { Host: `127.0.0.1:${proxyPort}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("memwarden-proxy");
  });
});
