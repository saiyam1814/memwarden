//
// Secure daemon-log contract. Every path here is below a fresh temporary
// directory; no test resolves ~/.memwarden or a real LaunchAgents directory.
//

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAEMON_LOG_FILENAME,
  DAEMON_LOG_MAX_BYTES,
  DAEMON_LOG_MODE_FILE,
  DAEMON_LOG_MODE_JOURNALD,
  DAEMON_LOG_ROTATED_FILENAME,
  checkDaemonLog,
  daemonUsesFileLogging,
  openSecureDaemonLog,
  startDaemonLogMaintenance,
  type DaemonLogMaintenance,
} from "../src/daemon/log.js";
import { ensureDaemon } from "../src/daemon/ensure.js";

const roots: string[] = [];
const posixIt = process.platform === "win32" ? it.skip : it;

function tempRoot(label = "memwarden-daemon-log-"): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function logPath(root: string): string {
  return join(root, DAEMON_LOG_FILENAME);
}

function rotatedPath(root: string): string {
  return join(root, DAEMON_LOG_ROTATED_FILENAME);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function oversized(marker = "TAIL-MARKER"): Buffer {
  const content = Buffer.alloc(DAEMON_LOG_MAX_BYTES + 4096, 0x78);
  content.write(marker, content.length - Buffer.byteLength(marker));
  return content;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("secure daemon log target", () => {
  it("creates only the fixed regular daemon.log target", () => {
    const root = tempRoot();
    const log = openSecureDaemonLog(root);
    try {
      expect(log.path).toBe(logPath(root));
      expect(log.rotatedPath).toBe(rotatedPath(root));
      expect(lstatSync(log.path).isFile()).toBe(true);
      expect(fstatSync(log.fd).ino).toBe(statSync(log.path).ino);
      expect(readdirSync(root)).toEqual([DAEMON_LOG_FILENAME]);
    } finally {
      log.close();
    }
  });

  posixIt("creates new logs as 0600 and corrects existing current/rotated modes", () => {
    const root = tempRoot();
    writeFileSync(logPath(root), "current");
    writeFileSync(rotatedPath(root), "prior");
    chmodSync(logPath(root), 0o644);
    chmodSync(rotatedPath(root), 0o644);

    const log = openSecureDaemonLog(root);
    log.close();

    expect(mode(logPath(root))).toBe(0o600);
    expect(mode(rotatedPath(root))).toBe(0o600);
  });

  it("rejects a directory without replacing it", () => {
    const root = tempRoot();
    mkdirSync(logPath(root));

    expect(() => openSecureDaemonLog(root)).toThrow(/refusing unsafe daemon log/i);
    expect(lstatSync(logPath(root)).isDirectory()).toBe(true);
  });

  posixIt("rejects an outside symlink without reading, chmodding, or truncating its target", () => {
    const root = tempRoot();
    const outside = tempRoot("memwarden-log-outside-");
    const sentinel = "PRIVATE-LOG-CONTENT-MUST-NOT-APPEAR";
    const target = join(outside, "outside.log");
    writeFileSync(target, sentinel);
    chmodSync(target, 0o644);
    const originalMode = mode(target);
    symlinkSync(target, logPath(root));

    let message = "";
    try {
      openSecureDaemonLog(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/refusing unsafe daemon log/i);
    expect(message).not.toContain(sentinel);
    expect(readFileSync(target, "utf8")).toBe(sentinel);
    expect(mode(target)).toBe(originalMode);
    expect(lstatSync(logPath(root)).isSymbolicLink()).toBe(true);
  });

  posixIt("rejects an outside hard link before chmod or rotation", () => {
    const root = tempRoot();
    const outside = tempRoot("memwarden-log-hardlink-");
    const target = join(outside, "outside.log");
    const content = oversized("HARDLINK-TAIL");
    writeFileSync(target, content);
    chmodSync(target, 0o644);
    linkSync(target, logPath(root));

    expect(() => openSecureDaemonLog(root)).toThrow(/refusing unsafe daemon log/i);
    expect(readFileSync(target).equals(content)).toBe(true);
    expect(mode(target)).toBe(0o644);
    expect(statSync(target).nlink).toBe(2);
  });

  posixIt("rejects a FIFO promptly and leaves it a FIFO", () => {
    const root = tempRoot();
    execFileSync("mkfifo", [logPath(root)]);

    expect(() => openSecureDaemonLog(root)).toThrow(/refusing unsafe daemon log/i);
    expect(lstatSync(logPath(root)).isFIFO()).toBe(true);
  });

  posixIt("rejects an unsafe rotated target before modifying the oversized current log", () => {
    const root = tempRoot();
    const outside = tempRoot("memwarden-rotated-outside-");
    const target = join(outside, "outside.log");
    const current = oversized("CURRENT-STAYS-INTACT");
    writeFileSync(logPath(root), current);
    writeFileSync(target, "ROTATED-TARGET-STAYS-INTACT");
    symlinkSync(target, rotatedPath(root));

    expect(() => openSecureDaemonLog(root)).toThrow(/refusing unsafe daemon log/i);
    expect(readFileSync(logPath(root)).equals(current)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("ROTATED-TARGET-STAYS-INTACT");
    expect(lstatSync(rotatedPath(root)).isSymbolicLink()).toBe(true);
  });

  posixIt("rejects a symlink used as the configured data directory", () => {
    const parent = tempRoot();
    const realRoot = tempRoot("memwarden-real-log-root-");
    const linkedRoot = join(parent, "linked-data");
    symlinkSync(realRoot, linkedRoot);

    expect(() => openSecureDaemonLog(linkedRoot)).toThrow(/refusing unsafe daemon log/i);
    expect(readdirSync(realRoot)).toEqual([]);
  });
});

describe("bounded same-inode rotation", () => {
  posixIt("preserves one bounded tail, truncates the current inode, and keeps old writers live", async () => {
    const root = tempRoot();
    const marker = "LAUNCHD-OPEN-DESCRIPTOR-CONTINUES";
    writeFileSync(logPath(root), oversized(marker));
    chmodSync(logPath(root), 0o644);

    // Model launchd: this append descriptor exists before the rotation check.
    const launchdFd = openSync(logPath(root), "a");
    const inode = fstatSync(launchdFd).ino;
    await checkDaemonLog(root);

    expect(statSync(logPath(root)).ino).toBe(inode);
    expect(statSync(logPath(root)).size).toBe(0);
    expect(statSync(rotatedPath(root)).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(readFileSync(rotatedPath(root), "utf8")).toContain(marker);
    expect(mode(logPath(root))).toBe(0o600);
    expect(mode(rotatedPath(root))).toBe(0o600);

    writeSync(launchdFd, Buffer.from("written-after-in-place-truncate\n"));
    closeSync(launchdFd);
    expect(readFileSync(logPath(root), "utf8")).toBe(
      "written-after-in-place-truncate\n",
    );
    expect(readdirSync(root).sort()).toEqual([
      DAEMON_LOG_FILENAME,
      DAEMON_LOG_ROTATED_FILENAME,
    ]);
  });

  it("bounds a pre-existing oversized prior generation without creating more generations", async () => {
    const root = tempRoot();
    writeFileSync(logPath(root), "current");
    writeFileSync(rotatedPath(root), oversized("BOUNDED-PRIOR-TAIL"));

    await checkDaemonLog(root);

    const prior = readFileSync(rotatedPath(root));
    expect(prior.length).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(prior.toString("utf8")).toContain("BOUNDED-PRIOR-TAIL");
    expect(readdirSync(root).sort()).toEqual([
      DAEMON_LOG_FILENAME,
      DAEMON_LOG_ROTATED_FILENAME,
    ]);
  });

  it("serializes concurrent checks into one bounded backup", async () => {
    const root = tempRoot();
    writeFileSync(logPath(root), oversized("CONCURRENT-TAIL"));

    await Promise.all(Array.from({ length: 64 }, () => checkDaemonLog(root)));

    expect(statSync(logPath(root)).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(statSync(rotatedPath(root)).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(readFileSync(rotatedPath(root), "utf8")).toContain("CONCURRENT-TAIL");
    expect(readdirSync(root).sort()).toEqual([
      DAEMON_LOG_FILENAME,
      DAEMON_LOG_ROTATED_FILENAME,
    ]);
  });
});

describe("detached daemon integration", () => {
  posixIt("corrects and bounds an older log even when the daemon is already alive", async () => {
    const root = tempRoot();
    writeFileSync(logPath(root), oversized("ALREADY-LIVE-TAIL"));
    chmodSync(logPath(root), 0o644);
    const inode = statSync(logPath(root)).ino;
    const server = createServer((_request, response) => {
      response.writeHead(200).end("ok");
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");

    try {
      await expect(
        ensureDaemon(`http://127.0.0.1:${address.port}`, root, 100),
      ).resolves.toBe("already");
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    }

    expect(statSync(logPath(root)).ino).toBe(inode);
    expect(mode(logPath(root))).toBe(0o600);
    expect(statSync(logPath(root)).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(statSync(rotatedPath(root)).size).toBeLessThanOrEqual(DAEMON_LOG_MAX_BYTES);
    expect(readFileSync(rotatedPath(root), "utf8")).toContain("ALREADY-LIVE-TAIL");
  });
});

describe("periodic daemon log lifecycle", () => {
  it("uses an unref'd timer, rotates periodically, and stops cleanly", async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const root = tempRoot();
    let maintenance: DaemonLogMaintenance | undefined;
    try {
      maintenance = startDaemonLogMaintenance(root, { intervalMs: 25 });
      expect(maintenance.periodic).toBe(true);
      expect(maintenance.timer).toBeDefined();
      expect(maintenance.timer!.hasRef()).toBe(false);
      writeFileSync(logPath(root), oversized("PERIODIC-TAIL"));

      await vi.advanceTimersByTimeAsync(25);
      expect(statSync(logPath(root)).size).toBe(0);
      expect(readFileSync(rotatedPath(root), "utf8")).toContain("PERIODIC-TAIL");

      maintenance.stop();
      expect(maintenance.stopped).toBe(true);
      // Assert this maintenance handle was cleared. A process-wide timer count
      // can include unrelated async-runtime cleanup in full-suite CI workers.
      expect(clearIntervalSpy).toHaveBeenCalledWith(maintenance.timer);
      writeFileSync(logPath(root), oversized("MUST-NOT-ROTATE-AFTER-STOP"));
      await vi.advanceTimersByTimeAsync(100);
      expect(statSync(logPath(root)).size).toBeGreaterThan(DAEMON_LOG_MAX_BYTES);
    } finally {
      maintenance?.stop();
      clearIntervalSpy.mockRestore();
    }
  });

  it("bounds Windows logs at startup without retaining a timer-backed lifecycle", async () => {
    vi.useFakeTimers();
    const root = tempRoot();
    writeFileSync(logPath(root), oversized("WINDOWS-STARTUP-TAIL"));
    const baselineTimers = vi.getTimerCount();
    const maintenance = startDaemonLogMaintenance(root, {
      intervalMs: 25,
      platform: "win32",
    });
    try {
      expect(maintenance.periodic).toBe(false);
      expect(maintenance.timer).toBeUndefined();
      expect(vi.getTimerCount()).toBe(baselineTimers);
      expect(statSync(logPath(root)).size).toBe(0);
      expect(readFileSync(rotatedPath(root), "utf8")).toContain("WINDOWS-STARTUP-TAIL");

      writeFileSync(logPath(root), oversized("NO-WINDOWS-PERIODIC-HANDLE"));
      await vi.advanceTimersByTimeAsync(100);
      expect(statSync(logPath(root)).size).toBeGreaterThan(DAEMON_LOG_MAX_BYTES);
    } finally {
      maintenance.stop();
    }
    expect(maintenance.stopped).toBe(true);
  });

  it("selects files for detached/launchd and never infers them for journald", () => {
    expect(daemonUsesFileLogging(DAEMON_LOG_MODE_FILE, "linux", true)).toBe(true);
    expect(daemonUsesFileLogging(DAEMON_LOG_MODE_JOURNALD, "darwin", true)).toBe(false);
    expect(daemonUsesFileLogging(undefined, "darwin", true)).toBe(true);
    expect(daemonUsesFileLogging(undefined, "darwin", false)).toBe(false);
    expect(daemonUsesFileLogging(undefined, "linux", true)).toBe(false);
  });
});
