//
// Fleet registry (#25): mem::observe should record each capturing agent as
// active in its project, and listActiveAgents should return only the agents
// still inside the recency window. Harness mirrors test/forget.test.ts
// (in-process kernel + StateKV + registerCoreFunctions).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import { listActiveAgents, currentBranch, type FleetAgent } from "../src/functions/fleet.js";
import { __resetGitIdentityCache } from "../src/functions/git-identity.js";

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-fleet" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});
afterEach(() => __resetKernelSingleton());

function capture(over: {
  sessionId: string;
  cwd: string;
  agent: string;
  file: string;
  timestamp?: string;
}) {
  return sdk.trigger({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId: over.sessionId,
      project: over.cwd,
      cwd: over.cwd,
      timestamp: over.timestamp ?? new Date().toISOString(),
      agent: over.agent,
      data: {
        tool_name: "Edit",
        tool_input: { file_path: over.file },
        tool_output: "ok",
      },
    },
  });
}

describe("fleet registry", () => {
  it("tracks two agents active in the same project, each with its own files", async () => {
    const cwd = "/tmp/memwarden-fleet-proj";
    await capture({ sessionId: "s1", cwd, agent: "claude-code", file: "src/a.ts" });
    await capture({ sessionId: "s2", cwd, agent: "cursor", file: "src/b.ts" });

    const agents = await listActiveAgents(kv, cwd);
    expect(agents).toHaveLength(2);

    const bySession = new Map(agents.map((a) => [a.sessionId, a]));
    expect(bySession.get("s1")?.host).toBe("claude-code");
    expect(bySession.get("s1")?.files).toContain("src/a.ts");
    expect(bySession.get("s2")?.host).toBe("cursor");
    expect(bySession.get("s2")?.files).toContain("src/b.ts");
  });

  it("bumps captureCount and merges recent files across repeated captures", async () => {
    const cwd = "/tmp/memwarden-fleet-proj2";
    await capture({ sessionId: "s1", cwd, agent: "claude-code", file: "src/a.ts" });
    await capture({ sessionId: "s1", cwd, agent: "claude-code", file: "src/b.ts" });

    const [agent] = await listActiveAgents(kv, cwd);
    expect(agent?.captureCount).toBe(2);
    expect(agent?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("excludes agents last seen outside the recency window", async () => {
    const cwd = "/tmp/memwarden-fleet-proj3";
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    await capture({ sessionId: "stale", cwd, agent: "claude-code", file: "src/a.ts", timestamp: old });
    await capture({ sessionId: "fresh", cwd, agent: "claude-code", file: "src/b.ts" });

    const agents = await listActiveAgents(kv, cwd, 15 * 60 * 1000);
    expect(agents.map((a) => a.sessionId)).toEqual(["fresh"]);
  });

  it("does not surface agents from a different project", async () => {
    await capture({ sessionId: "s1", cwd: "/tmp/memwarden-fleet-proj-a", agent: "claude-code", file: "src/a.ts" });
    await capture({ sessionId: "s2", cwd: "/tmp/memwarden-fleet-proj-b", agent: "cursor", file: "src/b.ts" });

    const agents = await listActiveAgents(kv, "/tmp/memwarden-fleet-proj-a");
    expect(agents.map((a) => a.sessionId)).toEqual(["s1"]);
  });

  it("leaves capture behaviour unchanged when only one agent is active", async () => {
    const cwd = "/tmp/memwarden-fleet-single";
    const result = await capture({ sessionId: "s1", cwd, agent: "claude-code", file: "src/a.ts" });
    expect((result as { observationId?: string }).observationId).toBeTruthy();
    const obs = await kv.list(KV.observations("s1"));
    expect(obs).toHaveLength(1);
  });
});

describe("currentBranch", () => {
  const dirs: string[] = [];
  function tempDir(): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-fleet-branch-")));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    __resetGitIdentityCache();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reads the branch name from a synthetic .git/HEAD", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/fleet-agent-registry\n");
    expect(currentBranch(repo)).toBe("feat/fleet-agent-registry");
  });

  it("returns undefined on detached HEAD", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "HEAD"), "abc123deadbeef\n");
    expect(currentBranch(repo)).toBeUndefined();
  });

  it("returns undefined outside a git repo", () => {
    const dir = tempDir();
    expect(currentBranch(dir)).toBeUndefined();
  });
});
