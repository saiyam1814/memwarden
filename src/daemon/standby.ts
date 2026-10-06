//
// Supervised standby. A launchd/systemd-supervised daemon that finds another
// memwarden already serving its port must not exit 0: the supervisor reads
// that as "job finished" and never restarts the brain again until the next
// login, so the unsupervised winner runs with no crash recovery. Instead the
// supervised instance waits here, holding nothing (no store, no log
// rotation), and boots once the port is released AND the previous holder's
// process has exited: a daemon releases its port first and only then saves
// its vector index and closes the store, and two processes appending to one
// store lose writes (the oplog append is serialized per process only).

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Who holds the REST port right now. */
export type PortHolder =
  /** a memwarden daemon answered /livez */
  | "memwarden"
  /** something accepted the connection but did not answer in time */
  | "busy"
  /** nothing is listening */
  | "free"
  /** something that is not memwarden answered */
  | "foreign";

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

function isRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  return cause?.code === "ECONNREFUSED";
}

export async function probePort(
  port: number,
  opts: { timeoutMs?: number; fetchFn?: FetchLike } = {},
): Promise<PortHolder> {
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/memwarden/livez`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!res.ok) return "foreign";
    const body = (await res.json().catch(() => null)) as { service?: unknown } | null;
    return body?.service === "memwarden" ? "memwarden" : "foreign";
  } catch (err) {
    if (isRefused(err)) return "free";
    // A timeout is what a memwarden blocked in a long synchronous task looks
    // like: keep waiting. A reset or protocol error is not a memwarden
    // answering; booting then reports the conflict (exit 0, no crash loop),
    // or, if it was a memwarden after all, exits for a retry into standby.
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return "busy";
    }
    return "foreign";
  }
}

/** Where the serving daemon records its pid (see writeDaemonPidfile). */
export function daemonPidfile(dataDir: string): string {
  return join(dataDir, "daemon.pid");
}

/** Record this process as the brain's daemon. Called once the port is bound. */
export function writeDaemonPidfile(dataDir: string, pid = process.pid): void {
  try {
    writeFileSync(daemonPidfile(dataDir), `${pid}\n`, { mode: 0o600 });
  } catch {
    // best-effort: standby falls back to a grace period without it
  }
}

/** Remove the pidfile if it is still ours. Called last in graceful shutdown. */
export function removeDaemonPidfile(dataDir: string, pid = process.pid): void {
  try {
    if (readFileSync(daemonPidfile(dataDir), "utf8").trim() === String(pid)) {
      rmSync(daemonPidfile(dataDir), { force: true });
    }
  } catch {
    // already gone
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * After the port is released, wait for the previous holder's process to exit.
 * With a pidfile: until that pid is gone (capped, in case a crashed daemon's
 * pid was reused). Without one (a pre-0.2.1 holder): a fixed grace period,
 * long enough for its shutdown to save the vector index and close the store.
 */
export async function awaitHolderExit(
  dataDir: string,
  opts: {
    capMs?: number;
    graceMs?: number;
    alive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<"exited" | "grace" | "cap"> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = opts.alive ?? processAlive;
  let pid: number | null = null;
  try {
    const n = parseInt(readFileSync(daemonPidfile(dataDir), "utf8").trim(), 10);
    pid = Number.isInteger(n) && n > 0 && n !== process.pid ? n : null;
  } catch {
    pid = null;
  }
  if (pid === null) {
    await sleep(opts.graceMs ?? 5_000);
    return "grace";
  }
  const deadline = Date.now() + (opts.capMs ?? 30_000);
  while (alive(pid)) {
    if (Date.now() >= deadline) return "cap";
    await sleep(250);
  }
  return "exited";
}

/**
 * Wait until no memwarden holds `port`. Returns "free" (boot normally) or
 * "foreign" (a different program holds it; booting will report the
 * conflict). Never returns while a memwarden is serving.
 */
export async function awaitPortHandoff(
  port: number,
  opts: {
    intervalMs?: number;
    probe?: (port: number) => Promise<PortHolder>;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
    /** Runs after a release, before booting (see awaitHolderExit). */
    afterRelease?: () => Promise<unknown>;
  } = {},
): Promise<"free" | "foreign"> {
  const probe = opts.probe ?? ((p: number) => probePort(p));
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.log(line));
  let polls = 0;
  for (;;) {
    const holder = await probe(port);
    if (holder === "free" || holder === "foreign") {
      if (polls > 0) {
        await opts.afterRelease?.();
        log(`[memwarden] standby: port ${port} released; taking over.`);
      }
      return holder;
    }
    // Say so on entry, then every ~5 minutes, so a long standby is visible
    // in the log rather than looking like a hang.
    if (polls % 60 === 0) {
      log(
        `[memwarden] standby: another memwarden holds port ${port} (${holder}); this ` +
          `supervised instance takes over when it exits.`,
      );
    }
    polls++;
    await sleep(opts.intervalMs ?? 5000);
  }
}

/**
 * Exit code for a lost bind. A supervised instance that lost to another
 * memwarden exits for a retry (its relaunch waits in standby); anything else
 * exits 0, so a foreign program on the port never causes a crash loop.
 */
export function exitCodeForAddrInUse(
  supervised: boolean,
  holder: PortHolder,
): number {
  return supervised && holder !== "foreign" ? EXIT_RETRY_STANDBY : 0;
}

/** EX_TEMPFAIL: lost the bind race to another memwarden; the supervisor
 * relaunches us and the relaunch waits in standby. */
export const EXIT_RETRY_STANDBY = 75;
