//
// The supervised daemon must own the brain. Live finding (2026-10-04): at
// login an MCP server revived the daemon before launchd started its own; the
// launchd instance hit EADDRINUSE, exited 0, and launchd (KeepAlive on
// failure only) never supervised it again. The brain then ran for days with
// no crash restart, and hooks drop captures silently when the daemon is down.
//
// Covered here: revival goes through the supervisor when the service serves
// this brain; a supervised instance waits in standby while another memwarden
// holds the port and takes over when it exits (end to end, real daemon).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  __installedServiceForTests,
  __macPlistForTests,
  __startViaSupervisorForTests,
  __systemdUnitForTests,
  serviceServes,
  supervisorOf,
  type InstalledService,
} from "../src/daemon/service.js";
import { ensureDaemon } from "../src/daemon/ensure.js";
import { awaitPortHandoff, probePort, type PortHolder } from "../src/daemon/standby.js";

const posixIt = process.platform === "win32" ? it.skip : it;
const roots: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memwarden-supervision-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A local server answering /memwarden/livez the way `handler` says. */
async function livezServer(
  handler: (res: import("node:http").ServerResponse) => void,
  port = 0,
): Promise<{ server: Server; port: number; url: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/memwarden/livez") handler(res);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  const p = (server.address() as AddressInfo).port;
  return { server, port: p, url: `http://127.0.0.1:${p}` };
}

const memwardenLivez = (res: import("node:http").ServerResponse): void => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status: "ok", service: "memwarden" }));
};

async function freePort(): Promise<number> {
  const { server, port } = await livezServer(memwardenLivez);
  await new Promise<void>((r) => server.close(() => r()));
  servers.splice(servers.indexOf(server), 1);
  return port;
}

describe("supervisorOf", () => {
  it("recognizes our launchd job by its XPC service name", () => {
    expect(supervisorOf({ XPC_SERVICE_NAME: "ai.memwarden.daemon" })).toBe("launchd");
    // Every launchd job and app has an XPC_SERVICE_NAME; only ours counts.
    expect(supervisorOf({ XPC_SERVICE_NAME: "application.com.devin.123" })).toBeNull();
  });

  it("recognizes our systemd unit (INVOCATION_ID + journald log mode)", () => {
    expect(
      supervisorOf({ INVOCATION_ID: "abc", MEMWARDEN_DAEMON_LOG_MODE: "journald" }),
    ).toBe("systemd");
    expect(supervisorOf({ INVOCATION_ID: "abc" })).toBeNull();
    expect(supervisorOf({ MEMWARDEN_DAEMON_LOG_MODE: "journald" })).toBeNull();
  });

  it("treats a detached spawn or a shell as unsupervised", () => {
    expect(supervisorOf({})).toBeNull();
    expect(supervisorOf({ MEMWARDEN_DAEMON_LOG_MODE: "file" })).toBeNull();
  });
});

describe("installed service discovery", () => {
  it("reads the brain and default port back from the generated plist", () => {
    const home = tempRoot();
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ai.memwarden.daemon.plist"),
      __macPlistForTests("/usr/bin/node", "/Users/a&b/.memwarden", "s3cret"),
    );
    const svc = __installedServiceForTests("darwin", home);
    expect(svc).toMatchObject({ kind: "launchd", dataDir: "/Users/a&b/.memwarden", port: 3111 });
  });

  it("reads a tuned port back from the generated systemd unit", () => {
    const home = tempRoot();
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    const prev = process.env["MEMWARDEN_REST_PORT"];
    process.env["MEMWARDEN_REST_PORT"] = "4111";
    try {
      writeFileSync(
        join(dir, "memwarden.service"),
        __systemdUnitForTests("/usr/bin/node", "/home/u/.memwarden", "s3cret"),
      );
    } finally {
      if (prev === undefined) delete process.env["MEMWARDEN_REST_PORT"];
      else process.env["MEMWARDEN_REST_PORT"] = prev;
    }
    const svc = __installedServiceForTests("linux", home);
    expect(svc).toMatchObject({ kind: "systemd", dataDir: "/home/u/.memwarden", port: 4111 });
  });

  it("returns null with no service file, and on unsupported platforms", () => {
    expect(__installedServiceForTests("darwin", tempRoot())).toBeNull();
    expect(__installedServiceForTests("win32", tempRoot())).toBeNull();
  });

  it("serves only its own brain on its own port", () => {
    const svc: InstalledService = {
      kind: "launchd",
      path: "/x",
      dataDir: resolve("/b/.memwarden"),
      port: 3111,
    };
    expect(serviceServes(svc, "http://localhost:3111", "/b/.memwarden")).toBe(true);
    expect(serviceServes(svc, "http://localhost:3111", "/b/.memwarden/")).toBe(true);
    expect(serviceServes(svc, "http://localhost:4111", "/b/.memwarden")).toBe(false);
    expect(serviceServes(svc, "http://localhost:3111", "/tmp/experiment")).toBe(false);
    expect(serviceServes(svc, "not a url", "/b/.memwarden")).toBe(false);
  });
});

describe("starting through the supervisor", () => {
  const svc = (kind: "launchd" | "systemd"): InstalledService => ({
    kind,
    path: "/x",
    dataDir: "/b",
    port: 3111,
  });

  it("launchd: kickstart WITHOUT -k, so a live daemon is never restarted", () => {
    const calls: string[][] = [];
    expect(__startViaSupervisorForTests(svc("launchd"), (c, a) => void calls.push([c, ...a]))).toBe(true);
    expect(calls).toEqual([
      ["launchctl", "kickstart", `gui/${userInfo().uid}/ai.memwarden.daemon`],
    ]);
  });

  it("systemd: start the user unit", () => {
    const calls: string[][] = [];
    expect(__startViaSupervisorForTests(svc("systemd"), (c, a) => void calls.push([c, ...a]))).toBe(true);
    expect(calls).toEqual([["systemctl", "--user", "start", "memwarden"]]);
  });

  it("reports false when the supervisor cannot be asked", () => {
    expect(
      __startViaSupervisorForTests(svc("launchd"), () => {
        throw new Error("Could not find service");
      }),
    ).toBe(false);
  });
});

describe("ensureDaemon revival", () => {
  posixIt("asks the supervisor (and never spawns) when the service serves this brain", async () => {
    const dataDir = tempRoot();
    const port = await freePort();
    let spawned = 0;
    let kicked = 0;
    const result = await ensureDaemon(`http://127.0.0.1:${port}`, dataDir, 5000, {
      service: () => ({ kind: "launchd", path: "/x", dataDir: resolve(dataDir), port }),
      startViaSupervisor: () => {
        kicked++;
        // The supervisor brings the daemon up a moment later.
        setTimeout(() => void livezServer(memwardenLivez, port), 300);
        return true;
      },
      spawnDetached: (() => {
        spawned++;
        return { unref() {} };
      }) as never,
    });
    expect(result).toBe("started");
    expect(kicked).toBe(1);
    expect(spawned).toBe(0);
  });

  posixIt("spawns detached when the service serves a different brain", async () => {
    const dataDir = tempRoot();
    const port = await freePort();
    let spawned = 0;
    let kicked = 0;
    const result = await ensureDaemon(`http://127.0.0.1:${port}`, dataDir, 600, {
      service: () => ({ kind: "launchd", path: "/x", dataDir: "/somewhere/else", port }),
      startViaSupervisor: () => {
        kicked++;
        return true;
      },
      spawnDetached: (() => {
        spawned++;
        return { unref() {} };
      }) as never,
    });
    expect(result).toBe("failed"); // the stub spawn never answers
    expect(kicked).toBe(0);
    expect(spawned).toBe(1);
  });

  posixIt("falls back to a detached spawn when the supervisor cannot be asked", async () => {
    const dataDir = tempRoot();
    const port = await freePort();
    let spawned = 0;
    await ensureDaemon(`http://127.0.0.1:${port}`, dataDir, 300, {
      service: () => ({ kind: "launchd", path: "/x", dataDir: resolve(dataDir), port }),
      startViaSupervisor: () => false,
      spawnDetached: (() => {
        spawned++;
        return { unref() {} };
      }) as never,
    });
    expect(spawned).toBe(1);
  });

  posixIt("does nothing when the daemon is already up", async () => {
    const dataDir = tempRoot();
    const { url, port } = await livezServer(memwardenLivez);
    let kicked = 0;
    const result = await ensureDaemon(url, dataDir, 300, {
      service: () => ({ kind: "launchd", path: "/x", dataDir: resolve(dataDir), port }),
      startViaSupervisor: () => {
        kicked++;
        return true;
      },
    });
    expect(result).toBe("already");
    expect(kicked).toBe(0);
  });
});

describe("port probing", () => {
  it("free: nothing listening", async () => {
    expect(await probePort(await freePort())).toBe("free");
  });

  it("memwarden: a memwarden livez answered", async () => {
    const { port } = await livezServer(memwardenLivez);
    expect(await probePort(port)).toBe("memwarden");
  });

  it("foreign: something else answered", async () => {
    const notFound = await livezServer((res) => {
      res.statusCode = 404;
      res.end();
    });
    expect(await probePort(notFound.port)).toBe("foreign");
    const otherJson = await livezServer((res) => res.end(JSON.stringify({ status: "ok" })));
    expect(await probePort(otherJson.port)).toBe("foreign");
  });

  it("busy: accepted but did not answer in time (a blocked memwarden looks like this)", async () => {
    const { port } = await livezServer(() => undefined); // never responds
    expect(await probePort(port, { timeoutMs: 200 })).toBe("busy");
  });
});

describe("awaitPortHandoff", () => {
  it("waits while a memwarden serves, then takes over", async () => {
    const seq: PortHolder[] = ["memwarden", "busy", "memwarden", "free"];
    const lines: string[] = [];
    let slept = 0;
    const r = await awaitPortHandoff(3111, {
      probe: async () => seq.shift()!,
      sleep: async () => void slept++,
      log: (l) => void lines.push(l),
    });
    expect(r).toBe("free");
    expect(slept).toBe(3);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/standby/);
    expect(lines[1]).toMatch(/released/);
  });

  it("returns at once (and quietly) when the port is free or foreign", async () => {
    const lines: string[] = [];
    for (const holder of ["free", "foreign"] as const) {
      const r = await awaitPortHandoff(3111, {
        probe: async () => holder,
        sleep: async () => {
          throw new Error("must not sleep");
        },
        log: (l) => void lines.push(l),
      });
      expect(r).toBe(holder);
    }
    expect(lines).toEqual([]);
  });
});

// The real daemon, from source, under a simulated launchd environment.
describe("supervised daemon end to end", () => {
  function startDaemon(port: number, dataDir: string, supervised: boolean): {
    child: ChildProcess;
    output: () => string;
  } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MEMWARDEN_REST_PORT: String(port),
      MEMWARDEN_DATA_DIR: dataDir,
      MEMWARDEN_EMBEDDING_PROVIDER: "none",
      MEMWARDEN_SECRET: "test-secret",
      MEMWARDEN_DAEMON_LOG_MODE: "stdio",
    };
    delete env["XPC_SERVICE_NAME"];
    delete env["INVOCATION_ID"];
    if (supervised) env["XPC_SERVICE_NAME"] = "ai.memwarden.daemon";
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    return { child, output: () => out };
  }

  async function until(cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  posixIt(
    "stands by while another memwarden serves, then binds when it exits",
    async () => {
      const dataDir = tempRoot();
      // The "unsupervised winner": answers livez exactly like a daemon.
      const holder = await livezServer(memwardenLivez);
      const d = startDaemon(holder.port, dataDir, true);
      let exitCode: number | null = null;
      d.child.on("exit", (code) => (exitCode = code));

      expect(await until(() => d.output().includes("standby"), 20_000)).toBe(true);
      // Holding nothing: it did not boot the kernel or open the store.
      expect(d.output()).not.toMatch(/kernel ready/);
      expect(exitCode).toBeNull();

      await new Promise<void>((r) => holder.server.close(() => r()));
      servers.splice(servers.indexOf(holder.server), 1);

      expect(await until(async () => (await probePort(holder.port)) === "memwarden", 25_000)).toBe(true);
      expect(d.output()).toMatch(/taking over/);
      expect(d.output()).toMatch(/kernel ready/);
      expect(exitCode).toBeNull();
    },
    60_000,
  );

  posixIt(
    "an unsupervised daemon still yields with exit 0 (no behavior change)",
    async () => {
      const dataDir = tempRoot();
      const holder = await livezServer(memwardenLivez);
      const d = startDaemon(holder.port, dataDir, false);
      const code = await new Promise<number | null>((r) => d.child.on("exit", (c) => r(c)));
      expect(code).toBe(0);
      expect(d.output()).toMatch(/already in use/);
      expect(d.output()).not.toMatch(/standby/);
    },
    60_000,
  );
});
