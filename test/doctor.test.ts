//
// The memory doctor: provenance capture on observe, and the stale /
// unsourced / safe audit against a real temp repo.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import type { CompressedObservation } from "../src/functions/types.js";
import type { DoctorReport } from "../src/functions/doctor.js";
import { extractProvenance, isUnsourced } from "../src/functions/provenance.js";

let sdk: Kernel;
let kv: StateKV;
const dirs: string[] = [];

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-doctor" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  __resetKernelSingleton();
});

function tempRepo(files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "memwarden-doctor-"));
  dirs.push(d);
  for (const f of files) {
    const p = join(d, f);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x");
  }
  return d;
}

async function observe(root: string, file: string, output: string) {
  return sdk.trigger({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId: "s1",
      project: root,
      cwd: root,
      timestamp: new Date().toISOString(),
      data: { tool_name: "Edit", tool_input: { file_path: file }, tool_output: output },
    },
  });
}

function doctor(root: string) {
  return sdk.trigger<{ root: string }, DoctorReport>({
    function_id: "mem::doctor",
    payload: { root },
  });
}

describe("provenance extraction", () => {
  it("captures files, command, cwd from a tool payload", () => {
    const p = extractProvenance({
      cwd: "/repo",
      timestamp: "2026-01-01",
      data: { tool_name: "Bash", tool_input: { command: "npm test", file: "src/x.ts" } },
    });
    expect(p.cwd).toBe("/repo");
    expect(p.files).toContain("src/x.ts");
    expect(p.command).toContain("npm test");
    expect(isUnsourced(p)).toBe(false);
  });
  it("flags an empty provenance as unsourced", () => {
    expect(isUnsourced(undefined)).toBe(true);
    expect(isUnsourced({ userConfirmed: false })).toBe(true);
  });
});

describe("mem::doctor", () => {
  it("marks a memory SAFE when its file still exists", async () => {
    const root = tempRepo(["src/auth.ts"]);
    await observe(root, "src/auth.ts", "auth uses IAM tokens");
    const r = await doctor(root);
    expect(r.total).toBe(1);
    expect(r.safe).toBe(1);
    expect(r.stale.length).toBe(0);
  });

  it("marks a memory STALE when its file is gone", async () => {
    const root = tempRepo(["src/auth.ts"]);
    await observe(root, "src/deleted.ts", "logic that lived in a since-deleted file");
    const r = await doctor(root);
    expect(r.stale.length).toBe(1);
    expect(r.stale[0]!.reason).toMatch(/deleted/);
    expect(r.safe).toBe(0);
  });

  it("marks a memory UNSOURCED when it has no evidence", async () => {
    const root = tempRepo([]);
    // No file path in tool_input -> no provenance files -> unsourced.
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt_submit",
        sessionId: "s1",
        project: root,
        cwd: root,
        timestamp: new Date().toISOString(),
        data: { note: "a vague thought with no source" },
      },
    });
    const r = await doctor(root);
    expect(r.unsourced.length).toBe(1);
  });
});
