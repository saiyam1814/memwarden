import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_LOG_LINES,
  readDaemonLogs,
  sanitizeDaemonLogLine,
} from "../src/cli/logs.js";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "memwarden-logs-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("bounded configured daemon log reader", () => {
  it("reads only <dataDir>/daemon.log, applies head/tail caps, and sanitizes secrets/control chars", () => {
    const root = tempDir();
    const unrelated = join(root, "unrelated.log");
    writeFileSync(unrelated, "UNRELATED_FILE_CANARY\n");
    writeFileSync(
      join(root, "daemon.log"),
      [
        "first",
        "second",
        "third",
        "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        "last\u001b[31m secret-value",
      ].join("\n") + "\n",
    );

    const head = readDaemonLogs({ dataDir: root, lines: 2 });
    expect(head.lines).toEqual(["first", "second"]);
    expect(head.truncated).toBe(true);
    expect(JSON.stringify(head)).not.toContain("UNRELATED_FILE_CANARY");

    const tail = readDaemonLogs({
      dataDir: root,
      tail: true,
      lines: 2,
      secret: "secret-value",
    });
    expect(tail.lines).toHaveLength(2);
    expect(tail.lines[0]).toContain("[REDACTED_SECRET]");
    expect(tail.lines[0]).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(tail.lines[1]).toBe("last [REDACTED_SECRET]");
    expect(tail.lines[1]).not.toContain("\u001b");
  });

  it("redacts private spans that cross physical log lines", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "daemon.log"),
      "before\n<private>line-one\nline-two</private>\nafter\n",
    );
    const result = readDaemonLogs({ dataDir: root, lines: 10 });
    expect(JSON.stringify(result.lines)).not.toContain("line-one");
    expect(JSON.stringify(result.lines)).not.toContain("line-two");
    expect(JSON.stringify(result.lines)).toContain("[REDACTED]");
  });

  it("returns a stable empty JSON contract when the configured log is absent", () => {
    const root = tempDir();
    const result = readDaemonLogs({ dataDir: root, tail: true, lines: 10 });
    expect(result).toMatchObject({
      format: "memwarden.logs.v1",
      path: join(root, "daemon.log"),
      tail: true,
      requestedLines: 10,
      returnedLines: 0,
      exists: false,
      truncated: false,
      lines: [],
    });
  });

  it("rejects symlinks instead of following the configured name to an unrelated file", () => {
    const root = tempDir();
    const outside = join(root, "outside.log");
    writeFileSync(outside, "SHOULD_NOT_BE_READ\n");
    symlinkSync(outside, join(root, "daemon.log"));
    expect(() => readDaemonLogs({ dataDir: root })).toThrow(/non-symlink/);
  });

  it("enforces the strict public line maximum and clips pathological lines", () => {
    const root = tempDir();
    writeFileSync(join(root, "daemon.log"), `${"x".repeat(20_000)}\n`);
    expect(() => readDaemonLogs({ dataDir: root, lines: MAX_LOG_LINES + 1 })).toThrow(
      /between 1 and 1000/,
    );
    const result = readDaemonLogs({ dataDir: root, lines: 1 });
    expect(result.lines[0]!.length).toBeLessThanOrEqual(8_192);
  });

  it("redacts exact and control-obfuscated secrets before controls can reconstruct them", () => {
    expect(sanitizeDaemonLogLine("auth short-secret done", "short-secret")).toBe(
      "auth [REDACTED_SECRET] done",
    );
    expect(
      sanitizeDaemonLogLine(
        "Bearer abcdefghij\u001b[31mklmnopqrstuvwxyz0123456789",
      ),
    ).toBe("[REDACTED_SECRET]");
  });
});
