//
// Injection/capture switches and the per-project exclude list, exercised
// through the real hook handlers and the real proxy server: when the user
// says off, NOTHING automatic flows — no observe, no SessionStart context,
// no Déjà Fix, no proxy injection or tee — while explicit paths stay alive.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionStart, handleCapture } from "../src/cli/hook.js";
import { isProjectExcluded } from "../src/functions/config.js";
import { startProxyServer } from "../src/proxy/server.js";

const ENV_KEYS = ["MEMWARDEN_INJECT", "MEMWARDEN_CAPTURE", "MEMWARDEN_DATA_DIR"];
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dataDir = mkdtempSync(join(tmpdir(), "mw-ctl-"));
  process.env.MEMWARDEN_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function fetchSpy(): { fn: typeof fetch; calls: () => string[] } {
  const spy = vi.fn(async (url: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ text: "<memory>ctx</memory>", fixes: [] }),
    text: async () => "",
  })) as unknown as ReturnType<typeof vi.fn>;
  return {
    fn: spy as unknown as typeof fetch,
    calls: () => spy.mock.calls.map((c: unknown[]) => String(c[0])),
  };
}

const SESSION_EVT = JSON.stringify({ cwd: "/work/alpha", session_id: "s1" });
const CAPTURE_EVT = JSON.stringify({
  cwd: "/work/alpha",
  session_id: "s1",
  tool_name: "Bash",
  tool_input: { command: "x" },
  tool_response: "error: boom",
});

describe("MEMWARDEN_INJECT=off", () => {
  it("silences SessionStart and Déjà Fix but leaves capture on", async () => {
    process.env.MEMWARDEN_INJECT = "off";
    const s = fetchSpy();
    expect(await handleSessionStart(SESSION_EVT, { baseUrl: "http://d", fetchFn: s.fn })).toBe("");
    expect(s.calls().length).toBe(0); // not even a daemon round-trip

    const out = await handleCapture(CAPTURE_EVT, { baseUrl: "http://d", fetchFn: s.fn });
    expect(out).toBe(""); // no Déjà Fix injection
    expect(s.calls()).toEqual(["http://d/memwarden/observe"]); // capture still flows
  });
});

describe("MEMWARDEN_CAPTURE=off", () => {
  it("silences observe but leaves injection on", async () => {
    process.env.MEMWARDEN_CAPTURE = "off";
    const s = fetchSpy();
    const ctx = await handleSessionStart(SESSION_EVT, { baseUrl: "http://d", fetchFn: s.fn });
    expect(ctx).toContain("ctx"); // injection alive
    await handleCapture(CAPTURE_EVT, { baseUrl: "http://d", fetchFn: s.fn });
    const urls = s.calls();
    expect(urls).not.toContain("http://d/memwarden/observe");
    // Déjà Fix lookup (an injection, not a capture) still allowed
    expect(urls).toContain("http://d/memwarden/dejafix/lookup");
  });
});

describe("per-project exclude list", () => {
  it("matches the project and everything under it, tolerating slashes/comments", () => {
    writeFileSync(join(dataDir, "excluded"), "# secret stuff\n/work/alpha/\n");
    expect(isProjectExcluded("/work/alpha")).toBe(true);
    expect(isProjectExcluded("/work/alpha/sub/dir")).toBe(true);
    expect(isProjectExcluded("/work/alphabet")).toBe(false);
    expect(isProjectExcluded("/work/beta")).toBe(false);
    expect(isProjectExcluded(undefined)).toBe(false);
  });

  it("blocks BOTH hook surfaces for an excluded project", async () => {
    writeFileSync(join(dataDir, "excluded"), "/work/alpha\n");
    const s = fetchSpy();
    expect(await handleSessionStart(SESSION_EVT, { baseUrl: "http://d", fetchFn: s.fn })).toBe("");
    expect(await handleCapture(CAPTURE_EVT, { baseUrl: "http://d", fetchFn: s.fn })).toBe("");
    expect(s.calls().length).toBe(0); // zero daemon traffic for excluded projects
  });
});

// --- proxy honors the same switches ---------------------------------

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolveP) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      resolveP({
        port: (srv.address() as AddressInfo).port,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

describe("proxy honors switches and excludes", () => {
  it("forwards the request untouched and captures nothing when project is excluded", async () => {
    writeFileSync(join(dataDir, "excluded"), "/repo\n");
    const daemonCalls: string[] = [];
    const daemon = await listen((req, res) => {
      daemonCalls.push(req.url ?? "");
      res.end(JSON.stringify({ text: "mem" }));
    });
    let sawSystems = -1;
    const upstream = await listen((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const p = JSON.parse(b) as { messages?: Array<{ role: string }> };
        sawSystems = (p.messages ?? []).filter((m) => m.role === "system").length;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }));
      });
    });
    const proxy = startProxyServer({
      port: 0,
      upstreamUrl: `http://127.0.0.1:${upstream.port}/v1`,
      daemonUrl: `http://127.0.0.1:${daemon.port}`,
      project: "/repo",
      cwd: "/repo",
    });
    await once(proxy.server, "listening");
    const port = (proxy.server.address() as AddressInfo).port;
    try {
      await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "q" }] }),
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(sawSystems).toBe(0); // no memory injected
      expect(daemonCalls.length).toBe(0); // no search, no observe
    } finally {
      await proxy.close();
      await daemon.close();
      await upstream.close();
    }
  });
});
