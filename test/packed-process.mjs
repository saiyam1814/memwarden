// Child-process runner shared by the packed-artifact contract and its focused
// regression test. A detached grandchild can keep stdout/stderr pipe handles
// open after the direct child exits (especially under Windows job objects), so
// waiting only for ChildProcess "close" can hang forever. Settle from "exit"
// after a short drain grace and forcibly release only this runner's pipe ends.

import { spawn } from "node:child_process";

function destroyPipes(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export async function runBoundedProcess(command, values = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const closeGraceMs = options.closeGraceMs ?? 1_000;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const allowFailure = options.allowFailure === true;
  const label = options.label ?? [command, ...values].join(" ");
  const onLog = options.onLog ?? (() => undefined);

  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let exitCode = null;
    let exitSignal = null;
    let closeGraceTimer;
    let killGraceTimer;

    const child = spawn(command, values, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: options.shell === true,
      windowsHide: true,
    });
    options.onSpawn?.(child);

    const commandTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      onLog(`timeout after ${timeoutMs}ms; terminating direct child pid=${child.pid ?? "unknown"}`);
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child may already have exited while a descendant retains
        // its pipes. The bounded fallback below still releases those streams.
      }
      killGraceTimer = setTimeout(() => {
        destroyPipes(child);
        finish(exitCode ?? -1, exitSignal, "timeout-fallback");
      }, killGraceMs);
    }, timeoutMs);

    const finish = (code, signal, completion, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(commandTimer);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      options.onSettled?.(child);
      onLog(
        `exit=${code ?? -1} signal=${signal ?? "-"} completion=${completion}${
          timedOut ? " timeout" : ""
        }`,
      );
      if (stdout) onLog(`stdout:\n${stdout.trimEnd()}`);
      if (stderr) onLog(`stderr:\n${stderr.trimEnd()}`);
      const result = {
        code: code ?? -1,
        signal,
        stdout,
        stderr,
        timedOut,
        completion,
      };
      if (spawnError) {
        rejectPromise(spawnError);
      } else if (timedOut) {
        rejectPromise(new Error(`command timed out after ${timeoutMs}ms: ${label}`));
      } else if (!allowFailure && code !== 0) {
        rejectPromise(
          new Error(
            `command failed (${code}): ${label}\n${stderr || stdout}`.trimEnd(),
          ),
        );
      } else {
        resolvePromise(result);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      onLog(`spawn error: ${error.message}`);
      finish(-1, null, "spawn-error", error);
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Normally "close" follows immediately after buffered output drains. If
      // a detached descendant inherited a pipe, it never does; stop waiting on
      // that unrelated process after a bounded grace period.
      closeGraceTimer = setTimeout(() => {
        onLog(
          `stdio remained open ${closeGraceMs}ms after direct child exit; releasing inherited pipes`,
        );
        destroyPipes(child);
        finish(code, signal, "exit-fallback");
      }, closeGraceMs);
    });
    child.once("close", (code, signal) => {
      finish(code ?? exitCode, signal ?? exitSignal, "close");
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
