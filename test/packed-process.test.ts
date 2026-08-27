// Regression for the packed runner's Windows hang: a direct CLI can exit while
// its detached daemon retains inherited stdout/stderr pipe handles. Waiting
// only for ChildProcess "close" deadlocks; the bounded runner must settle from
// "exit" and release its own pipe ends without leaving the daemon behind.

import { describe, expect, it } from "vitest";
import { runBoundedProcess } from "./packed-process.mjs";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilGone(pid: number): Promise<void> {
  for (let i = 0; i < 100 && processIsAlive(pid); i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

describe("packed child-process lifecycle", () => {
  it("settles after direct exit when a detached grandchild keeps its pipes open", async () => {
    const launcher = [
      'const { spawn } = require("node:child_process");',
      'const held = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
      '  detached: true, stdio: ["ignore", "inherit", "inherit"]',
      '});',
      "held.unref();",
      'console.log(`HELD_PID=${held.pid}`);',
    ].join("\n");
    let heldPid: number | undefined;

    try {
      const started = Date.now();
      const result = await runBoundedProcess(process.execPath, ["-e", launcher], {
        timeoutMs: 5_000,
        closeGraceMs: 50,
      });
      const match = /HELD_PID=(\d+)/.exec(result.stdout);
      heldPid = match ? Number(match[1]) : undefined;

      expect(result.code).toBe(0);
      expect(result.completion).toBe("exit-fallback");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(heldPid).toBeTypeOf("number");
      expect(processIsAlive(heldPid!)).toBe(true);
    } finally {
      if (heldPid !== undefined && processIsAlive(heldPid)) {
        try {
          process.kill(heldPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await waitUntilGone(heldPid);
      }
    }
    if (heldPid !== undefined) expect(processIsAlive(heldPid)).toBe(false);
  });

  it("terminates and rejects a direct child that exceeds its command timeout", async () => {
    const started = Date.now();
    await expect(
      runBoundedProcess(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { timeoutMs: 100, closeGraceMs: 50, killGraceMs: 250 },
      ),
    ).rejects.toThrow(/command timed out after 100ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
