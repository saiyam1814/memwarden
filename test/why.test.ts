//
// mem::why — explain one memory's trust verdict against the live repo.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";

let sdk: Kernel;
let dirs: string[] = [];

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker(
    "in-process",
    { workerName: "memwarden-why" },
    { store: new StoreMemory() },
  );
  registerCoreFunctions(sdk, new StateKV(sdk));
});

afterEach(() => {
  __resetKernelSingleton();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  dirs = [];
});

describe("mem::why", () => {
  it("explains a verified memory and marks it injectable", async () => {
    const root = mkdtempSync(join(tmpdir(), "mw-why-"));
    dirs.push(root);
    writeFileSync(join(root, "auth.ts"), "export const TTL = 15;\n");

    const obs = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "s-why",
        project: root,
        cwd: root,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "Edit",
          tool_input: { file_path: "auth.ts" },
          tool_output: "set TTL to 15 minutes in auth.ts",
        },
      },
    });

    const why = await sdk.trigger<
      unknown,
      {
        found: boolean;
        injectable?: boolean;
        verdict?: { status: string; trust: string };
        advice?: string;
      }
    >({
      function_id: "mem::why",
      payload: { observationId: obs.observationId, root },
    });

    expect(why.found).toBe(true);
    expect(why.verdict?.status).toBe("verified");
    expect(why.verdict?.trust).toBe("verified");
    expect(why.injectable).toBe(true);
    expect(why.advice).toMatch(/safe to auto-inject/i);
  });

  it("explains a stale memory and says it is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "mw-why-stale-"));
    dirs.push(root);
    writeFileSync(join(root, "auth.ts"), "export const TTL = 15;\n");

    const obs = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "s-why-stale",
        project: root,
        cwd: root,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "Edit",
          tool_input: { file_path: "auth.ts" },
          tool_output: "set TTL to 15 minutes in auth.ts",
        },
      },
    });

    writeFileSync(join(root, "auth.ts"), "export const TTL = 60;\n");

    const why = await sdk.trigger<
      unknown,
      {
        found: boolean;
        injectable?: boolean;
        verdict?: { status: string; trust: string; reason: string };
        advice?: string;
      }
    >({
      function_id: "mem::why",
      payload: { observationId: obs.observationId, root },
    });

    expect(why.found).toBe(true);
    expect(why.verdict?.status).toBe("stale");
    expect(why.injectable).toBe(false);
    expect(why.advice).toMatch(/Refused|forget|--fix-stale/i);
  });

  it("returns found:false for unknown ids", async () => {
    const why = await sdk.trigger<unknown, { found: boolean; reason?: string }>({
      function_id: "mem::why",
      payload: { observationId: "obs_does_not_exist" },
    });
    expect(why.found).toBe(false);
    expect(why.reason).toMatch(/No observation/i);
  });
});
