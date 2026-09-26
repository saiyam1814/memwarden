//
// `memwarden repair --legacy`: memories distilled from pre-0.0.8 captures
// (tool-name title, raw JSON body, no facts/concepts; 54% of one real brain)
// are re-extracted into readable successors that keep the original evidence,
// and the legacy rows are retired through mem::forget.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreMemory } from "../src/state/store-memory.js";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import {
  isLegacyJunkMemory,
  splitLegacyBody,
  type RepairReport,
} from "../src/functions/repair.js";
import type { Memory } from "../src/functions/types.js";

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-repair" }, { store: new StoreMemory() });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  __resetKernelSingleton();
});

function legacy(id: string, title: string, content: string, extra: Partial<Memory> = {}): Memory {
  return {
    id,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    type: "architecture",
    title,
    content,
    facts: [],
    concepts: [],
    files: ["src/auth.ts"],
    sessionIds: ["sess-old"],
    strength: 6,
    version: 1,
    isLatest: true,
    sourceObservationIds: [`obs_${id}`],
    projectPath: "/work/app",
    provenance: {
      cwd: "/work/app",
      files: ["src/auth.ts"],
      fileHashes: { "src/auth.ts": "a".repeat(64) },
      command: "Edit",
      userConfirmed: false,
    },
    ...extra,
  } as Memory;
}

describe("legacy shape detection", () => {
  it("matches only tool-name titles over raw JSON bodies with no facts or concepts", () => {
    expect(isLegacyJunkMemory(legacy("a", "exec", '{"command":"git status"} | {"success":true}'))).toBe(true);
    expect(isLegacyJunkMemory(legacy("b", "Edit", '{"file_path":"/x"}'))).toBe(true);
    expect(isLegacyJunkMemory(legacy("c", "Edited auth.ts", '{"file_path":"/x"}'))).toBe(false);
    expect(isLegacyJunkMemory(legacy("d", "exec", "ran git status"))).toBe(false);
    expect(isLegacyJunkMemory(legacy("e", "exec", '{"a":1}', { facts: ["x"] }))).toBe(false);
    expect(isLegacyJunkMemory(legacy("f", "exec", '{"a":1}', { origin: "manual" }))).toBe(false);
  });

  it("splits `input | output`, tolerates a clipped output, and recovers keys from clipped input", () => {
    expect(splitLegacyBody('{"command":"ls"} | {"stdout":"a b"}')).toEqual({
      input: { command: "ls" },
      output: { stdout: "a b" },
    });
    expect(splitLegacyBody('{"command":"ls"} | {"stdout":"a b')!.output).toBe('{"stdout":"a b');
    expect(splitLegacyBody('{"file_path":"/w/src/auth.ts","old_string":"ROTATE_MS = 900_000","new_str')).toEqual({
      input: { file_path: "/w/src/auth.ts", old_string: "ROTATE_MS = 900_000" },
      output: "",
    });
    expect(splitLegacyBody("not json at all")).toBeNull();
  });
});

describe("mem::repair-legacy", () => {
  async function seed(): Promise<void> {
    await kv.set(KV.memories, "mem_legacy_edit", legacy(
      "mem_legacy_edit",
      "Edit",
      '{"file_path":"/work/app/src/auth.ts","old_string":"ROTATE_MS = 900_000","new_string":"ROTATE_MS = 3_600_000"} | {"success":true}',
    ));
    await kv.set(KV.memories, "mem_legacy_exec", legacy(
      "mem_legacy_exec",
      "exec",
      '{"command":"npm test -- --run","workdir":"/work/app"} | {"success":true,"output":"12 passed"}',
      { files: [], provenance: { cwd: "/work/app", command: "exec: npm test -- --run", userConfirmed: false } },
    ));
    await kv.set(KV.memories, "mem_good", legacy("mem_good", "Edited auth.ts", "a real memory", {
      facts: ["changed: a → b"],
      concepts: ["auth"],
    }));
    await kv.set(KV.retentionScores, "mem_legacy_edit", { score: 0.5 });
  }

  it("dry run reports what it would do and changes nothing", async () => {
    await seed();
    const r = await sdk.trigger<unknown, RepairReport>({ function_id: "mem::repair-legacy", payload: {} });
    expect(r.applied).toBe(false);
    expect(r.legacy).toBe(2);
    expect(r.repaired).toBe(2);
    expect(r.samples.map((x) => x.after).sort()).toEqual([
      "auth.ts: ROTATE_MS = 900_000 → ROTATE_MS = 3_600_000",
      "npm test -- --run",
    ]);
    expect(await kv.get(KV.memories, "mem_legacy_edit")).not.toBeNull();
  });

  it("apply replaces each legacy row with a readable successor that keeps its evidence", async () => {
    await seed();
    const r = await sdk.trigger<unknown, RepairReport>({
      function_id: "mem::repair-legacy",
      payload: { apply: true },
    });
    expect(r.repaired).toBe(2);
    expect(r.failed).toBe(0);
    expect(await kv.get(KV.memories, "mem_legacy_edit")).toBeNull();
    expect(await kv.get(KV.memories, "mem_legacy_exec")).toBeNull();
    // forget cleans the retention score row too (it used to be orphaned)
    expect(await kv.get(KV.retentionScores, "mem_legacy_edit")).toBeNull();

    const all = await kv.list<Memory>(KV.memories);
    const edit = all.find((m) => m.title.startsWith("auth.ts:"))!;
    expect(edit).toBeDefined();
    expect(edit.facts).toContain("changed: ROTATE_MS = 900_000 → ROTATE_MS = 3_600_000");
    expect(edit.content).not.toMatch(/^\{/);
    // original capture-time evidence carried over verbatim, never re-hashed
    expect(edit.provenance?.fileHashes).toEqual({ "src/auth.ts": "a".repeat(64) });
    expect(edit.sessionIds).toEqual(["sess-old"]);
    expect(edit.claimFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const exec = all.find((m) => m.title === "npm test -- --run")!;
    expect(exec).toBeDefined();
    expect(exec.content).toContain("12 passed");

    // untouched: the good memory, and nothing legacy-shaped remains
    expect(await kv.get(KV.memories, "mem_good")).not.toBeNull();
    const again = await sdk.trigger<unknown, RepairReport>({
      function_id: "mem::repair-legacy",
      payload: { apply: true },
    });
    expect(again.legacy).toBe(0);
  });

  it("respects --limit", async () => {
    await seed();
    const r = await sdk.trigger<unknown, RepairReport>({
      function_id: "mem::repair-legacy",
      payload: { apply: true, limit: 1 },
    });
    expect(r.repaired).toBe(1);
    expect(r.legacy).toBe(2);
  });
});
