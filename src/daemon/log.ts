//
// Secure bounded file logging for daemon processes whose stdout/stderr are
// owned by a supervisor. launchd keeps its log descriptor open, so rotation
// must never rename daemon.log: preserve one bounded tail in daemon.log.1 and
// truncate the current descriptor in place instead.
//

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DAEMON_LOG_FILENAME = "daemon.log";
export const DAEMON_LOG_ROTATED_FILENAME = "daemon.log.1";
export const DAEMON_LOG_MODE_ENV = "MEMWARDEN_DAEMON_LOG_MODE";
export const DAEMON_LOG_MODE_FILE = "file";
export const DAEMON_LOG_MODE_JOURNALD = "journald";

/**
 * The current file is checked at startup and, on POSIX file-log paths, once a
 * minute. When it exceeds 1 MiB, its newest 1 MiB is copied to the sole prior
 * generation and the same current inode is truncated. Immediately after each
 * check, each generation is at most 1 MiB (writes between checks may exceed it).
 */
export const DAEMON_LOG_MAX_BYTES = 1024 * 1024;
export const DAEMON_LOG_CHECK_INTERVAL_MS = 60_000;
const OWNER_ONLY_MODE = 0o600;
const SAFE_LOG_ERROR =
  "refusing unsafe daemon log; expected an owner-only regular file inside the data directory";

/** A deliberately content-free error safe to print even for hostile targets. */
export class DaemonLogSecurityError extends Error {
  readonly code = "ERR_MEMWARDEN_UNSAFE_DAEMON_LOG";

  constructor() {
    super(SAFE_LOG_ERROR);
    this.name = "DaemonLogSecurityError";
  }
}

interface LogPaths {
  root: string;
  realRoot: string;
  current: string;
  rotated: string;
}

function unsafe(): never {
  throw new DaemonLogSecurityError();
}

function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DaemonLogSecurityError) throw error;
    // Do not forward filesystem errors: while they normally contain only a
    // path, a stable content-free message is the safer public contract.
    throw new DaemonLogSecurityError();
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function resolveLogPaths(dataDir: string): LogPaths {
  return guarded(() => {
    const root = resolve(dataDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });

    // Reject a symlink (or any non-directory) at the configured directory
    // itself. Otherwise an attacker could swap its destination between the
    // containment check and launchd opening StandardOutPath.
    if (!lstatSync(root).isDirectory()) unsafe();

    const current = resolve(root, DAEMON_LOG_FILENAME);
    const rotated = resolve(root, DAEMON_LOG_ROTATED_FILENAME);
    if (!isInside(root, current) || !isInside(root, rotated)) unsafe();

    const realRoot = realpathSync(root);
    if (
      realpathSync(dirname(current)) !== realRoot ||
      realpathSync(dirname(rotated)) !== realRoot
    ) {
      unsafe();
    }
    return { root, realRoot, current, rotated };
  });
}

/** The only supported current-log path. Callers cannot supply a second target. */
export function daemonLogPath(dataDir: string): string {
  return join(resolve(dataDir), DAEMON_LOG_FILENAME);
}

/** The only supported prior-generation path. */
export function rotatedDaemonLogPath(dataDir: string): string {
  return join(resolve(dataDir), DAEMON_LOG_ROTATED_FILENAME);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertFdClosed(fd: number): void {
  try {
    fstatSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBADF") return;
    unsafe();
  }
  unsafe();
}

function assertRegularOwnedFile(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1) unsafe();
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    unsafe();
  }
}

function assertPathStillNamesFd(path: string, fdStat: Stats): void {
  const pathStat = lstatSync(path);
  assertRegularOwnedFile(pathStat);
  if (!sameFile(fdStat, pathStat)) unsafe();
}

function enforceOwnerOnly(fd: number): Stats {
  // Windows exposes only a read-only bit, not POSIX owner/group/other masks.
  // Keep its legacy best-effort chmod behavior so detached rotation remains
  // cross-platform; launchd always takes the strict POSIX branch below.
  if (process.platform === "win32") {
    try {
      fchmodSync(fd, OWNER_ONLY_MODE);
    } catch {
      // There is no representable 0600 contract on this platform.
    }
    return fstatSync(fd);
  }

  fchmodSync(fd, OWNER_ONLY_MODE);
  const secured = fstatSync(fd);
  if ((secured.mode & 0o777) !== OWNER_ONLY_MODE) unsafe();
  return secured;
}

function secureFd(path: string, flags: number): number {
  return guarded(() => {
    let fd: number | undefined;
    try {
      // O_NONBLOCK prevents a hostile FIFO from hanging the process before
      // fstat can reject it. O_NOFOLLOW rejects a final-component symlink.
      fd = openSync(
        path,
        flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        OWNER_ONLY_MODE,
      );
      const opened = fstatSync(fd);
      assertRegularOwnedFile(opened);
      assertPathStillNamesFd(path, opened);

      // Descriptor-based chmod cannot be redirected by a path swap.
      const secured = enforceOwnerOnly(fd);
      assertRegularOwnedFile(secured);
      assertPathStillNamesFd(path, secured);
      return fd;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the original safe failure.
        }
      }
      throw error;
    }
  });
}

function openCurrent(path: string): number {
  return secureFd(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_APPEND,
  );
}

function openRotated(path: string): number {
  return secureFd(path, constants.O_CREAT | constants.O_RDWR);
}

function existingPath(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readTail(fd: number, size: number): Buffer {
  const length = Math.min(size, DAEMON_LOG_MAX_BYTES);
  const out = Buffer.allocUnsafe(length);
  const start = Math.max(0, size - length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, out, read, length - read, start + read);
    if (count === 0) break;
    read += count;
  }
  return read === length ? out : out.subarray(0, read);
}

function replaceWithBoundedTail(fd: number, sourceSize: number): void {
  const tail = readTail(fd, sourceSize);
  ftruncateSync(fd, 0);
  let written = 0;
  while (written < tail.length) {
    written += writeSync(fd, tail, written, tail.length - written, written);
  }
  ftruncateSync(fd, written);
  enforceOwnerOnly(fd);
}

function writeBoundedTail(fd: number, tail: Buffer): void {
  ftruncateSync(fd, 0);
  let written = 0;
  while (written < tail.length) {
    written += writeSync(fd, tail, written, tail.length - written, written);
  }
  ftruncateSync(fd, written);
  enforceOwnerOnly(fd);
}

function maintain(paths: LogPaths, currentFd: number): void {
  guarded(() => {
    // Re-check containment and identity on every pass. All mutations below use
    // validated descriptors, never a pathname that could begin following a
    // replacement symlink between periodic checks.
    if (realpathSync(paths.root) !== paths.realRoot) unsafe();
    const currentStat = fstatSync(currentFd);
    assertRegularOwnedFile(currentStat);
    assertPathStillNamesFd(paths.current, currentStat);
    enforceOwnerOnly(currentFd);

    let rotatedFd: number | undefined;
    try {
      if (existingPath(paths.rotated)) {
        rotatedFd = openRotated(paths.rotated);
        const rotatedStat = fstatSync(rotatedFd);
        if (rotatedStat.size > DAEMON_LOG_MAX_BYTES) {
          replaceWithBoundedTail(rotatedFd, rotatedStat.size);
        }
        const bounded = fstatSync(rotatedFd);
        if (bounded.size > DAEMON_LOG_MAX_BYTES) unsafe();
        assertPathStillNamesFd(paths.rotated, bounded);
      }

      if (currentStat.size > DAEMON_LOG_MAX_BYTES) {
        const tail = readTail(currentFd, currentStat.size);
        if (rotatedFd === undefined) rotatedFd = openRotated(paths.rotated);
        writeBoundedTail(rotatedFd, tail);
        const prior = fstatSync(rotatedFd);
        if (prior.size > DAEMON_LOG_MAX_BYTES) unsafe();
        assertPathStillNamesFd(paths.rotated, prior);

        // This is the central launchd invariant: truncate the descriptor that
        // names the current inode. Never rename/unlink/recreate daemon.log.
        ftruncateSync(currentFd, 0);
      }

      const currentAfter = enforceOwnerOnly(currentFd);
      assertPathStillNamesFd(paths.current, currentAfter);
    } finally {
      if (rotatedFd !== undefined) closeSync(rotatedFd);
    }
  });
}

const pendingChecks = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, operation: () => T): Promise<T> {
  const previous = pendingChecks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pendingChecks.set(key, current);
  return current.finally(() => {
    if (pendingChecks.get(key) === current) pendingChecks.delete(key);
  });
}

/**
 * A validated current-log descriptor. `check()` calls for the same fixed path
 * are serialized in-process; the fixed single backup and in-place truncation
 * also keep outcomes bounded if separate startup processes race.
 */
export interface SecureDaemonLog {
  readonly fd: number;
  readonly path: string;
  readonly rotatedPath: string;
  check(): Promise<void>;
  close(): void;
}

/**
 * Open/create, validate, chmod, and immediately rotate the fixed daemon log.
 * The returned descriptor is suitable for detached stdout/stderr inheritance.
 */
export function openSecureDaemonLog(dataDir: string): SecureDaemonLog {
  const paths = resolveLogPaths(dataDir);
  const fd = openCurrent(paths.current);
  let closed = false;
  try {
    maintain(paths, fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the content-free validation failure.
    }
    throw error;
  }

  return {
    fd,
    path: paths.current,
    rotatedPath: paths.rotated,
    check: () =>
      serialized(paths.current, () => {
        if (!closed) maintain(paths, fd);
      }),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // Timer cleanup must never derail the daemon's graceful native teardown.
      }
    },
  };
}

/** One serialized open/check/close pass, useful at installation boundaries. */
export async function checkDaemonLog(dataDir: string): Promise<void> {
  const key = daemonLogPath(dataDir);
  await serialized(key, () => {
    const log = openSecureDaemonLog(dataDir);
    log.close();
  });
}

export interface DaemonLogMaintenance {
  readonly periodic: boolean;
  readonly timer?: NodeJS.Timeout;
  readonly stopped: boolean;
  stop(): void;
}

export interface DaemonLogMaintenanceOptions {
  intervalMs?: number;
  onError?: (error: DaemonLogSecurityError) => void;
  /** Test seam for the Windows startup-only lifecycle. */
  platform?: NodeJS.Platform;
}

/**
 * Run the startup pass, then install an unref'd periodic pass on POSIX.
 * Windows bounds the file at startup but retains no second descriptor/timer:
 * detached descendants and open HANDLEs interact poorly with runner job
 * objects, and Windows has no launchd-style always-open inode requirement.
 */
export function startDaemonLogMaintenance(
  dataDir: string,
  options: DaemonLogMaintenanceOptions = {},
): DaemonLogMaintenance {
  const intervalMs = options.intervalMs ?? DAEMON_LOG_CHECK_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("daemon log check interval must be positive");
  }

  const log = openSecureDaemonLog(dataDir);
  let stopped = false;
  if ((options.platform ?? process.platform) === "win32") {
    // The synchronous startup check is complete; release and verify the HANDLE
    // before returning so it cannot extend a detached process/job lifecycle.
    const fd = log.fd;
    log.close();
    assertFdClosed(fd);
    return {
      periodic: false,
      get stopped() {
        return stopped;
      },
      stop() {
        stopped = true;
      },
    };
  }

  const report =
    options.onError ??
    (() => {
      console.error(`[memwarden] ${SAFE_LOG_ERROR}`);
    });
  const timer = setInterval(() => {
    if (stopped) return;
    void log.check().catch(() => report(new DaemonLogSecurityError()));
  }, intervalMs);
  timer.unref();

  return {
    periodic: true,
    timer,
    get stopped() {
      return stopped;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      log.close();
    },
  };
}

/**
 * New launchd plists opt in explicitly. The macOS fallback recognizes plists
 * written by 0.1.0, which had MEMWARDEN_DATA_DIR but no logging-mode marker.
 * Linux is never inferred: generated systemd units use journald rotation.
 */
export function daemonUsesFileLogging(
  mode: string | undefined = process.env[DAEMON_LOG_MODE_ENV],
  platform: NodeJS.Platform = process.platform,
  hasConfiguredDataDir = process.env.MEMWARDEN_DATA_DIR !== undefined,
): boolean {
  if (mode !== undefined) return mode === DAEMON_LOG_MODE_FILE;
  return platform === "darwin" && hasConfiguredDataDir;
}
