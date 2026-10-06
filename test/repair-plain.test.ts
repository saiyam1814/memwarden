//
// `memwarden repair --plain`: before 0.2.0 the retention sweep promoted every
// expiring capture that named a file, so plain commands, searches, and reads
// became permanent memories (2,651 of 4,453 on one real brain, 2026-10-06).
// Today's retention would never create them (worthDistilling). Repair retires
// exactly those, through mem::forget, and touches nothing else.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashFiles } from "../src/functions/verify.js";
import { StoreMemory } from "../src/state/store-memory.js";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import { isPlainCaptureMemory, type PlainRepairReport } from "../src/functions/repair.js";
import type { Memory } from "../src/functions/types.js";

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-repair-plain" }, { store: new StoreMemory() });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  __resetKernelSingleton();
});

/** A memory promoted 1:1 from one capture, the way the old sweep made them. */
function promoted(id: string, command: string, extra: Partial<Memory> = {}): Memory {
  return {
    id,
    createdAt: "2026-09-23T17:34:00.000Z",
    updatedAt: "2026-09-23T17:34:00.000Z",
    type: "architecture",
    title: command,
    content: `${command}. {"success":true,"output":"ok","error":null}`,
    facts: [],
    concepts: ["git"],
    files: ["/work/app"],
    sessionIds: ["sess-1"],
    strength: 5,
    version: 1,
    isLatest: true,
    supersedes: [`obs_${id}`],
    sourceObservationIds: [`obs_${id}`],
    projectPath: "/work/app",
    provenance: {
      cwd: "/work/app",
      files: ["/work/app"],
      command,
      agent: "claude-code",
      userConfirmed: false,
    },
    ...extra,
  } as Memory;
}

describe("plain capture detection", () => {
  it("matches plain commands, searches, reads, and fetches from one capture", () => {
    expect(isPlainCaptureMemory(promoted("a", "exec: git log -8 --oneline", { facts: ["ran: git log -8"] }))).toBe(true);
    expect(isPlainCaptureMemory(promoted("b", "Bash: gh auth status"))).toBe(true);
    expect(isPlainCaptureMemory(promoted("c", "grep", { title: 'Searched "Authorization"' }))).toBe(true);
    expect(isPlainCaptureMemory(promoted("d", "glob", { files: ["**/*.go", "/work/app"] }))).toBe(true);
    expect(isPlainCaptureMemory(promoted("e", "Read", { title: "Read README.md", files: ["README.md"] }))).toBe(true);
    expect(isPlainCaptureMemory(promoted("f", "web_search"))).toBe(true);
  });

  it("never touches edits or writes (the durability contract keeps them)", () => {
    expect(isPlainCaptureMemory(promoted("a", "Edit", { title: "Edited auth.ts" }))).toBe(false);
    expect(isPlainCaptureMemory(promoted("b", "edit"))).toBe(false);
    expect(isPlainCaptureMemory(promoted("c", "Write", { title: "Wrote posts.md" }))).toBe(false);
    expect(isPlainCaptureMemory(promoted("d", "apply_patch"))).toBe(false);
  });

  it("never touches a memory that knows something beyond the command", () => {
    expect(
      isPlainCaptureMemory(promoted("a", "Bash: npm test", { facts: ["ran: npm test", "error: 3 failing"] })),
    ).toBe(false);
    expect(
      isPlainCaptureMemory(promoted("b", "Read", { facts: ["the token TTL is 15 minutes"] })),
    ).toBe(false);
  });

  it("never touches a body that recorded a failure", () => {
    expect(
      isPlainCaptureMemory(promoted("a", "Bash: npm run build", { content: "npm run build. Command failed: tsc exited 2" })),
    ).toBe(false);
    // A success envelope's "error":null is not a failure.
    expect(isPlainCaptureMemory(promoted("b", "Bash: ls"))).toBe(true);
  });

  it("never touches manual, consolidated, or legacy-shaped memories", () => {
    expect(isPlainCaptureMemory(promoted("a", "Bash: git status", { origin: "manual" } as Partial<Memory>))).toBe(false);
    expect(
      isPlainCaptureMemory(promoted("b", "Read", { supersedes: ["o1", "o2", "o3"], sourceObservationIds: ["o1", "o2", "o3"] })),
    ).toBe(false);
    // tool-name title + raw JSON body is --legacy's shape
    expect(
      isPlainCaptureMemory(promoted("c", "exec", { title: "exec", content: '{"command":"ls"} | {"ok":1}', concepts: [] })),
    ).toBe(false);
  });

  it("never touches a tool it cannot classify", () => {
    expect(isPlainCaptureMemory(promoted("a", "mcp__linear__save_issue"))).toBe(false);
    expect(isPlainCaptureMemory(promoted("b", "Artifact"))).toBe(false);
    expect(isPlainCaptureMemory(promoted("c", "", { provenance: { userConfirmed: false } }))).toBe(false);
  });
});

describe("mem::repair-plain", () => {
  let repo: string;
  beforeEach(async () => {
    // A real checkout, so a plain read can verify (file unchanged) or go stale.
    repo = mkdtempSync(join(tmpdir(), "memwarden-repair-plain-"));
    writeFileSync(join(repo, "vector-persistence.ts"), "export const persisted = true;\n");
    writeFileSync(join(repo, "README.md"), "# old\n");
    const pointer = hashFiles(["vector-persistence.ts"], repo);
    const readme = hashFiles(["README.md"], repo);
    writeFileSync(join(repo, "README.md"), "# changed since capture\n");
    const at = (files: string[], fileHashes: Record<string, string>, command: string) => ({
      provenance: { cwd: repo, files, fileHashes, command, userConfirmed: false },
      files,
    });
    await kv.set(
      KV.memories,
      "mem_pointer",
      promoted("mem_pointer", "Read", {
        title: "Read vector-persistence.ts",
        ...at(["vector-persistence.ts"], pointer, "Read"),
      } as Partial<Memory>),
    );
    await kv.set(
      KV.memories,
      "mem_stale_read",
      promoted("mem_stale_read", "Read", {
        title: "Read README.md",
        ...at(["README.md"], readme, "Read"),
      } as Partial<Memory>),
    );
    await kv.set(KV.memories, "mem_git", promoted("mem_git", "exec: git log -8", { facts: ["ran: git log -8"] }));
    await kv.set(KV.memories, "mem_grep", promoted("mem_grep", "grep", { title: 'Searched "Bearer"' }));
    await kv.set(KV.memories, "mem_edit", promoted("mem_edit", "Edit", { title: "Edited auth.ts", facts: ["changed: a → b"] }));
    await kv.set(KV.memories, "mem_manual", promoted("mem_manual", "Bash: ls", { origin: "manual" } as Partial<Memory>));
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("dry run counts by type, keeps verified pointers, and changes nothing", async () => {
    const r = await sdk.trigger<unknown, PlainRepairReport>({ function_id: "mem::repair-plain", payload: {} });
    expect(r).toMatchObject({
      scanned: 6,
      plain: 4,
      keptVerified: 1,
      retirable: 3,
      retired: 0,
      failed: 0,
      applied: false,
    });
    expect(r.byType).toEqual({ command_run: 1, search: 1, file_read: 1 });
    expect((await kv.list(KV.memories)).length).toBe(6);
  });

  it("apply retires stale and never-verifiable plain captures, through mem::forget", async () => {
    const r = await sdk.trigger<unknown, PlainRepairReport>({
      function_id: "mem::repair-plain",
      payload: { apply: true },
    });
    expect(r).toMatchObject({ plain: 4, keptVerified: 1, retired: 3, failed: 0, applied: true });
    const left = (await kv.list<Memory>(KV.memories)).map((m) => m.id).sort();
    // The verified pointer survives; the stale read, the git log, and the
    // regex search are gone; edits and manual memories were never candidates.
    expect(left).toEqual(["mem_edit", "mem_manual", "mem_pointer"]);
    // idempotent
    const again = await sdk.trigger<unknown, PlainRepairReport>({
      function_id: "mem::repair-plain",
      payload: { apply: true },
    });
    expect(again).toMatchObject({ plain: 1, keptVerified: 1, retired: 0 });
  });

  it("respects --limit", async () => {
    const r = await sdk.trigger<unknown, PlainRepairReport>({
      function_id: "mem::repair-plain",
      payload: { apply: true, limit: 2 },
    });
    expect(r.retired).toBe(2);
    expect((await kv.list(KV.memories)).length).toBe(4);
  });
});
