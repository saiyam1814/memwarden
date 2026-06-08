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
  if (await daemonAlive(url)) return "already";
  // libSQL won't create the data directory; make it so the daemon can open
  // its db instead of crashing on boot.
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MEMWARDEN_DATA_DIR: dataDir },
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (await daemonAlive(url)) return "started";
  }
  return "failed";
}
