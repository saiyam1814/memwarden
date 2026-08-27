//
// Daemon lifecycle — the self-healing core. ensureDaemon makes the daemon
// reachable: if it isn't, spawn it detached (so it outlives the caller's
// shell) pointed at a stable global brain, and wait for it to answer. Shared
// by the CLI (`memwarden up`) and the MCP server (which revives a dead daemon
// on demand), so any entry point can bring the brain back with no human in
// the loop.

import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
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
    return res.ok;
  } catch {
    return false;
  }
}

export type EnsureResult = "already" | "started" | "failed";
export type DetachedLogLifecycle = "legacy-windows" | "secure-posix";

/** Select the unchanged v0.1.0 Windows lifecycle or the secure POSIX path. */
export function detachedLogLifecycle(
  platform: NodeJS.Platform = process.platform,
): DetachedLogLifecycle {
  return platform === "win32" ? "legacy-windows" : "secure-posix";
}

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
  const lifecycle = detachedLogLifecycle();
  const alive = await daemonAlive(url);

  // Preserve the exact 0.1.0 Windows lifecycle: an already-live daemon returns
  // before touching the log; a new daemon inherits one append-only descriptor;
  // the parent closes it immediately, and no maintenance marker is injected.
  if (lifecycle === "legacy-windows" && alive) return "already";

  // libSQL won't create the data directory; make it so the daemon can open
  // its db instead of crashing on boot.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  let child: ReturnType<typeof spawn>;
  if (lifecycle === "legacy-windows") {
    const logPath = join(dataDir, "daemon.log");
    const logFd = openSync(logPath, "a", 0o600);
    try {
      chmodSync(logPath, 0o600);
    } catch {
      // This is the v0.1.0 best-effort Windows behavior; POSIX security
      // guarantees are deliberately provided by the separate branch below.
    }
    try {
      child = spawn(process.execPath, [DAEMON_ENTRY], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, MEMWARDEN_DATA_DIR: dataDir },
      });
    } finally {
      closeSync(logFd);
    }
  } else {
    // POSIX detached fallbacks share launchd's secure open/rotate path. Run the
    // check even for a live daemon so repeated `up` corrects an older 0644 log.
    const log = openSecureDaemonLog(dataDir);
    if (alive) {
      log.close();
      return "already";
    }
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
  }
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (await daemonAlive(url)) return "started";
  }
  return "failed";
}
