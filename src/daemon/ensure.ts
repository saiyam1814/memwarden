//
// Daemon lifecycle — the self-healing core. ensureDaemon makes the daemon
// reachable: if it isn't, spawn it detached (so it outlives the caller's
// shell) pointed at a stable global brain, and wait for it to answer. Shared
// by the CLI (`memwarden up`) and the MCP server (which revives a dead daemon
// on demand), so any entry point can bring the brain back with no human in
// the loop.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAEMON_LOG_MODE_ENV,
  DAEMON_LOG_MODE_FILE,
  openSecureDaemonLog,
} from "./log.js";

// dist/daemon/ensure.js -> dist/index.js
export const DAEMON_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "index.js",
);

/** The stable, user-global brain location (one memory across every tool). */
export function defaultDataDir(): string {
  return process.env.MEMWARDEN_DATA_DIR ?? join(homedir(), ".memwarden");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export async function daemonAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/memwarden/livez`);
    const ok = res.ok;
    // Short-lived CLI probes do not consume the body. Cancel it explicitly so
    // undici cannot retain a response/connection handle while the CLI exits.
    await res.body?.cancel().catch(() => undefined);
    return ok;
  } catch {
    return false;
  }
}

export type EnsureResult = "already" | "started" | "failed";

/**
 * Ensure the daemon at `url` is up, spawning it if not. Idempotent and
 * race-safe: concurrent callers may both spawn, but the daemon exits 0 on
 * EADDRINUSE (see index.ts) so the loser simply goes away and the winner
 * serves. Returns once the daemon answers /livez or the timeout elapses.
 */
export async function ensureDaemon(
  url: string,
  dataDir: string = defaultDataDir(),
  timeoutMs = 15000,
): Promise<EnsureResult> {
  const alive = await daemonAlive(url);
  // libSQL won't create the data directory; make it so the daemon can open
  // its db instead of crashing on boot.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Detached fallbacks use the exact secure/open/rotate path used by launchd.
  // Run this even for an already-live daemon so a repeated `up` corrects an
  // older 0644 log without requiring a restart.
  const log = openSecureDaemonLog(dataDir);
  if (alive) {
    log.close();
    return "already";
  }
  // The descriptor is validated without following links and inherited for
  // both stdout/stderr; the child keeps the same bounds with its periodic pass.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [DAEMON_ENTRY], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: {
        ...process.env,
        MEMWARDEN_DATA_DIR: dataDir,
        [DAEMON_LOG_MODE_ENV]: DAEMON_LOG_MODE_FILE,
      },
    });
  } finally {
    log.close();
  }
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (await daemonAlive(url)) return "started";
  }
  return "failed";
}
