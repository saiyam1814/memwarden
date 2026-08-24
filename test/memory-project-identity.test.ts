//
// Distilled Memory identity across real git worktrees (#58).
//
// These are deliberately real repositories created with git, not synthetic
// .git fixtures: capture/consolidate in the main checkout, then ask doctor,
// why, safe recall, and canon inventory from another linked worktree. Both
// remote-derived and remote-less gitroot identities are covered.
//

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetKernelSingleton,
  registerWorker,
  type Kernel,
} from "../src/kernel/index.js";
import { StateKV } from "../src/state/kv.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { KV } from "../src/state/schema.js";
import {
  getSearchIndex,
  registerCoreFunctions,
  setEmbeddingProvider,
  setVectorIndex,
} from "../src/functions/index.js";
import { __resetColdRebuildForTests } from "../src/functions/search.js";
import {
  __resetGitIdentityCache,
  gitProjectKey,
} from "../src/functions/git-identity.js";
import type { DoctorReport } from "../src/functions/doctor.js";
import type { Memory } from "../src/functions/types.js";
import type { WhyResult } from "../src/functions/why.js";
import {
  recordFromMemory,
  verifyCanon,
} from "../src/cli/canon.js";

let sdk: Kernel;
let kv: StateKV;
const roots: string[] = [];

function runGit(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Memwarden Tests",
      GIT_AUTHOR_EMAIL: "tests@memwarden.local",
      GIT_COMMITTER_NAME: "Memwarden Tests",
      GIT_COMMITTER_EMAIL: "tests@memwarden.local",
    },
  });
}

interface Repos {
  main: string;
  worktree: string;
  other: string;
}

function realGitRepos(kind: "remote" | "remote-less"): Repos {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `mw-memory-id-${kind}-`)));
  roots.push(base);
  const main = join(base, "main");
  const worktree = join(base, "worktree");
  const other = join(base, "other");

  mkdirSync(main);
  runGit(main, "init", "--initial-branch=main");
  runGit(main, "config", "user.name", "Memwarden Tests");
  runGit(main, "config", "user.email", "tests@memwarden.local");
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src", "auth.ts"), "export const IDENTITY_TTL = 15;\n");
  runGit(main, "add", ".");
  runGit(main, "commit", "-m", "initial");
  if (kind === "remote") {
    runGit(
      main,
      "remote",
      "add",
      "origin",
      "git@github.com:memwarden-tests/project-identity.git",
    );
  }
  runGit(main, "worktree", "add", "-b", `identity-${kind}`, worktree);

  mkdirSync(other);
  runGit(other, "init", "--initial-branch=main");
  runGit(other, "config", "user.name", "Memwarden Tests");
  runGit(other, "config", "user.email", "tests@memwarden.local");
  mkdirSync(join(other, "src"));
  // Same relative name AND same bytes as the captured project: path-only or
  // hash-only filtering would leak/false-verify this memory.
  writeFileSync(join(other, "src", "auth.ts"), "export const IDENTITY_TTL = 15;\n");
  runGit(other, "add", ".");
  runGit(other, "commit", "-m", "initial");
  if (kind === "remote") {
    runGit(
      other,
      "remote",
      "add",
      "origin",
      "git@github.com:memwarden-tests/different-project.git",
    );
  }

  __resetGitIdentityCache();
  return { main, worktree, other };
}

beforeEach(() => {
  __resetKernelSingleton();
  __resetColdRebuildForTests();
  __resetGitIdentityCache();
  getSearchIndex().clear();
  setEmbeddingProvider(null);
  setVectorIndex(null);
  sdk = registerWorker("in-process", { workerName: "memory-project-identity" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  delete process.env.MEMWARDEN_RECALL_POLICY;
  __resetKernelSingleton();
  __resetGitIdentityCache();
  getSearchIndex().clear();
  setEmbeddingProvider(null);
  setVectorIndex(null);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function captureAndDistill(root: string): Promise<Memory> {
  for (let i = 0; i < 3; i++) {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "capture-session",
        project: root,
        cwd: root,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        data: {
          tool_name: "Edit",
          tool_input: {
            file_path: "src/auth.ts",
            old_string: `old-${i}`,
            new_string: `new-${i}`,
          },
          tool_output: `project identity sentinel policy observation ${i}`,
        },
      },
    });
  }
  const consolidated = await sdk.trigger<
    { now: number },
    { consolidated: number; folded: number }
  >({
    function_id: "mem::consolidate-pipeline",
    payload: { now: Date.now() + 10_000 },
  });
  expect(consolidated).toMatchObject({ consolidated: 1, folded: 3 });
  const memories = await kv.list<Memory>(KV.memories);
  expect(memories).toHaveLength(1);
  return memories[0]!;
}

async function doctor(root: string): Promise<DoctorReport> {
  return sdk.trigger({
    function_id: "mem::doctor",
    payload: { root, project: root },
  });
}

async function why(memoryId: string, root: string): Promise<WhyResult> {
  return sdk.trigger({
    function_id: "mem::why",
    payload: { observationId: memoryId, root },
  });
}

async function safeRecall(root: string): Promise<{
  results: Array<{ obsId: string; trust?: string }>;
  firewall?: { refused: number; samples: Array<{ obsId: string }> };
}> {
  return sdk.trigger({
    function_id: "mem::search",
    payload: {
      query: "project identity sentinel policy",
      project: root,
      cwd: root,
      safe_only: true,
      format: "compact",
      limit: 10,
    },
  });
}

async function inventory(root: string): Promise<Memory[]> {
  const result = await sdk.trigger<
    Record<string, unknown>,
    { memories: Memory[] }
  >({
    function_id: "mem::search",
    payload: {
      query: "",
      project: root,
      include_memories: true,
      all_projects: false,
      limit: 1000,
    },
  });
  return result.memories;
}

async function expectCheckoutVerdict(
  memoryId: string,
  root: string,
  expected: "verified" | "stale",
): Promise<void> {
  const [report, explanation, recall] = await Promise.all([
    doctor(root),
    why(memoryId, root),
    safeRecall(root),
  ]);
  expect(report.total).toBe(1);
  const doctorVerdict = report.stale.some((entry) => entry.id === memoryId)
    ? "stale"
    : report.verified === 1
      ? "verified"
      : "other";
  expect(doctorVerdict).toBe(expected);
  expect(explanation.found).toBe(true);
  expect(explanation.verdict?.status).toBe(expected);

  const recalled = recall.results.find((item) => item.obsId === memoryId);
  if (expected === "verified") {
    expect(recalled?.trust).toBe("verified");
    expect(explanation.injectable).toBe(true);
  } else {
    expect(recalled).toBeUndefined();
    expect(recall.firewall?.samples.some((sample) => sample.obsId === memoryId)).toBe(
      true,
    );
    expect(explanation.injectable).toBe(false);
  }
}

for (const kind of ["remote", "remote-less"] as const) {
  describe(`distilled Memory identity (${kind})`, () => {
    it("keeps doctor, why, safe recall, canon inventory, and local verification aligned", async () => {
      const repos = realGitRepos(kind);
      const memory = await captureAndDistill(repos.main);
      const stableKey = gitProjectKey(repos.main)!;

      expect(stableKey).toBeTruthy();
      expect(gitProjectKey(repos.worktree)).toBe(stableKey);
      expect(gitProjectKey(repos.other)).not.toBe(stableKey);
      expect(memory.project).toBeUndefined();
      expect(memory.projectPath).toBe(repos.main);
      expect(memory.projectKey).toBe(stableKey);
      expect(memory.captureCwd).toBe(repos.main);

      // Both checkouts initially have identical files, so every surface agrees.
      await expectCheckoutVerdict(memory.id, repos.main, "verified");
      await expectCheckoutVerdict(memory.id, repos.worktree, "verified");
      expect((await inventory(repos.main)).map((item) => item.id)).toEqual([
        memory.id,
      ]);
      expect((await inventory(repos.worktree)).map((item) => item.id)).toEqual([
        memory.id,
      ]);

      // Exercise the explicit legacy fallback in the same real worktree setup:
      // old consolidation stored the stable key in overloaded `project` and
      // had none of the three split fields.
      const legacy = { ...memory, project: stableKey } as Memory;
      delete legacy.projectPath;
      delete legacy.projectKey;
      delete legacy.captureCwd;
      await kv.set(KV.memories, legacy.id, legacy);
      await expectCheckoutVerdict(memory.id, repos.worktree, "verified");
      const migratedInventory = await inventory(repos.worktree);
      expect(migratedInventory[0]).toMatchObject({
        id: memory.id,
        projectPath: repos.main,
        projectKey: stableKey,
        captureCwd: repos.main,
      });

      // Canon promotion from the other worktree receives the resolved identity.
      // Also emulate an old absolute evidence key captured in the main checkout:
      // it must become repo-relative against the caller's worktree, not be lost.
      const storedHash = legacy.provenance?.fileHashes?.["src/auth.ts"]!;
      const absoluteCaptureFile = join(repos.main, "src", "auth.ts");
      const canonRecord = recordFromMemory(
        {
          ...migratedInventory[0]!,
          provenance: {
            ...migratedInventory[0]!.provenance,
            files: [absoluteCaptureFile],
            fileHashes: { [absoluteCaptureFile]: storedHash },
          },
        },
        repos.worktree,
        new Date().toISOString(),
      );
      expect(canonRecord?.files).toEqual(["src/auth.ts"]);
      expect(verifyCanon([canonRecord!], repos.worktree)[0]!.verdict).toBe(
        "verified",
      );

      // Diverge ONLY the caller worktree. Stable identity widens visibility,
      // while verification reads that caller path and therefore reports stale.
      writeFileSync(
        join(repos.worktree, "src", "auth.ts"),
        "export const IDENTITY_TTL = 60;\n",
      );
      await expectCheckoutVerdict(memory.id, repos.worktree, "stale");
      // The original checkout still has the captured bytes and stays verified.
      expect(readFileSync(join(repos.main, "src", "auth.ts"), "utf8")).toContain(
        "15",
      );
      await expectCheckoutVerdict(memory.id, repos.main, "verified");

      // A genuinely different repository with the same relative filename and
      // identical bytes must neither see the memory nor verify it accidentally.
      const otherDoctor = await doctor(repos.other);
      const otherRecall = await safeRecall(repos.other);
      expect(otherDoctor.total).toBe(0);
      expect(otherRecall.results.some((item) => item.obsId === memory.id)).toBe(
        false,
      );
      expect(await inventory(repos.other)).toEqual([]);
    });
  });
}
