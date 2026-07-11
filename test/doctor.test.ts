//
// The memory doctor: provenance capture on observe, plus stale, unsourced,
// sourced/verified, and conflict audits against a real temp repo.

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

async function observe(
  root: string,
  file: string,
  output: string,
  timestamp = new Date().toISOString(),
  sessionId = "s1",
) {
  return sdk.trigger({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId,
      project: root,
      cwd: root,
      timestamp,
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

function doctorScoped(root: string, project: string) {
  return sdk.trigger<{ root: string; project: string }, DoctorReport>({
    function_id: "mem::doctor",
    payload: { root, project },
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

  it("normalizes ABSOLUTE files under the capture cwd to repo-relative (F1 capture half)", () => {
    const p = extractProvenance({
      cwd: "/work/repo",
      data: { tool_name: "Edit", tool_input: { file_path: "/work/repo/src/auth.ts" } },
    });
    expect(p.files).toEqual(["src/auth.ts"]);
    // Outside the capture cwd: keep the absolute identity (cross-project
    // memories must never be re-rooted into the wrong repo).
    const q = extractProvenance({
      cwd: "/work/repo",
      data: { tool_name: "Read", tool_input: { file_path: "/etc/hosts" } },
    });
    expect(q.files).toEqual(["/etc/hosts"]);
    // Prefix-sibling dirs are NOT "under" cwd (/work/repo2 vs /work/repo).
    const r = extractProvenance({
      cwd: "/work/repo",
      data: { tool_name: "Read", tool_input: { file_path: "/work/repo2/src/auth.ts" } },
    });
    expect(r.files).toEqual(["/work/repo2/src/auth.ts"]);
  });

  it("extracts NESTED file paths under common keys (Kiro operations[], wrapped edits)", () => {
    // Kiro fsWrite/fsReplace documents tool_input.operations[].path.
    const kiro = extractProvenance({
      cwd: "/w",
      data: {
        tool_name: "fsReplace",
        tool_input: {
          operations: [
            { type: "replace", path: "src/a.ts", old_str: "x", new_str: "y" },
            { type: "create", path: "src/b.ts", content: "z" },
          ],
        },
      },
    });
    expect(kiro.files).toContain("src/a.ts");
    expect(kiro.files).toContain("src/b.ts");

    // Cursor/host variants that wrap file references one level down.
    const wrapped = extractProvenance({
      cwd: "/w",
      data: {
        tool_name: "applyPatch",
        tool_input: { changes: [{ file_path: "src/c.ts", diff: "…" }] },
      },
    });
    expect(wrapped.files).toContain("src/c.ts");

    // Claude Code MultiEdit shape keeps working (top-level file_path).
    const multi = extractProvenance({
      cwd: "/w",
      data: {
        tool_name: "MultiEdit",
        tool_input: {
          file_path: "src/d.ts",
          edits: [{ old_string: "a", new_string: "b" }],
        },
      },
    });
    expect(multi.files).toEqual(["src/d.ts"]);
  });

  it("bounds nested extraction by depth and count", () => {
    // Too deep (beyond ~4 levels) is ignored…
    const deep = extractProvenance({
      cwd: "/w",
      data: {
        tool_name: "X",
        tool_input: { a: { b: { c: { d: { e: { path: "src/too-deep.ts" } } } } } },
      },
    });
    expect(deep.files ?? []).not.toContain("src/too-deep.ts");
    // …and the total file count is capped.
    const many = extractProvenance({
      cwd: "/w",
      data: {
        tool_name: "X",
        tool_input: {
          operations: Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts` })),
        },
      },
    });
    expect((many.files ?? []).length).toBeLessThanOrEqual(20);
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

  it("reports its disk footprint and oplog length on every audit", async () => {
    const root = tempRepo(["src/auth.ts"]);
    await observe(root, "src/auth.ts", "auth uses IAM tokens");
    const r = await doctor(root);
    expect(r.footprint).toBeDefined();
    expect(r.footprint.oplogEntries).toBeGreaterThan(0);
    expect(typeof r.footprint.bytesOnDisk).toBe("number");
    expect(r.footprint.dataDir.length).toBeGreaterThan(0);
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

  it("flags a newer sourced memory that contradicts an older one", async () => {
    const root = tempRepo(["src/auth.ts"]);
    await observe(root, "src/auth.ts", "auth uses bearer tokens", "2026-01-01T00:00:00.000Z", "s1");
    await observe(root, "src/auth.ts", "auth uses session cookies", "2026-01-02T00:00:00.000Z", "s2");

    const r = await doctor(root);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]!.subject).toBe("auth");
    expect(r.conflicts[0]!.olderClaim).toContain("bearer tokens");
    expect(r.conflicts[0]!.newerClaim).toContain("session cookies");
  });

  it("flags polarity conflicts on the same subject and value", async () => {
    const root = tempRepo(["src/auth.ts"]);
    await observe(root, "src/auth.ts", "auth uses bearer tokens", "2026-01-01T00:00:00.000Z", "s1");
    await observe(root, "src/auth.ts", "auth does not use bearer tokens", "2026-01-02T00:00:00.000Z", "s2");

    const r = await doctor(root);
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]!.reason).toMatch(/changed polarity/);
  });

  it("does not flag equivalent sourced claims as conflicts", async () => {
    const root = tempRepo(["src/auth.ts"]);
    await observe(root, "src/auth.ts", "auth uses bearer tokens", "2026-01-01T00:00:00.000Z", "s1");
    await observe(root, "src/auth.ts", "auth uses bearer tokens", "2026-01-02T00:00:00.000Z", "s2");

    const r = await doctor(root);
    expect(r.conflicts.length).toBe(0);
  });

  it("does not flag stale memories as conflicts", async () => {
    const root = tempRepo(["src/auth.ts"]);
    await observe(root, "src/auth.ts", "auth uses bearer tokens", "2026-01-01T00:00:00.000Z", "s1");
    writeFileSync(join(root, "src", "auth.ts"), "rewritten");
    await observe(root, "src/auth.ts", "auth uses session cookies", "2026-01-02T00:00:00.000Z", "s2");

    const r = await doctor(root);
    expect(r.stale.length).toBe(1);
    expect(r.conflicts.length).toBe(0);
  });

  it("project-scopes the audit: doctor in repo A ignores repo B's memories", async () => {
    const repoA = tempRepo(["src/a.ts"]);
    const repoB = tempRepo(["src/b.ts"]);
    await observe(repoA, "src/a.ts", "feature A lives here", "2026-01-01T00:00:00.000Z", "sa");
    await observe(repoB, "src/b.ts", "feature B lives here", "2026-01-01T00:00:00.000Z", "sb");

    // Default whole-brain pool sees both projects.
    const all = await doctor(repoA);
    expect(all.total).toBe(2);

    // Scoped to repo A: only repo A's single memory is audited.
    const scoped = await doctorScoped(repoA, repoA);
    expect(scoped.total).toBe(1);
  });

  it("project-scoping does not surface cross-project conflicts", async () => {
    // Same subject + contradictory values, but in DIFFERENT projects. A
    // project-scoped audit must NOT pool them into a conflict.
    const repoA = tempRepo(["src/auth.ts"]);
    const repoB = tempRepo(["src/auth.ts"]);
    await observe(repoA, "src/auth.ts", "auth uses bearer tokens", "2026-01-01T00:00:00.000Z", "sa");
    await observe(repoB, "src/auth.ts", "auth uses session cookies", "2026-01-02T00:00:00.000Z", "sb");

    const scopedA = await doctorScoped(repoA, repoA);
    expect(scopedA.total).toBe(1);
    expect(scopedA.conflicts.length).toBe(0);

    // Whole-brain audit DOES pool them (the contradiction is real across the brain).
    const whole = await doctor(repoA);
    expect(whole.conflicts.length).toBe(1);
  });
});
