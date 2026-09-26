//
// Shell-read provenance end to end: a memory captured from `sed -n …` or
// `cat` carries capture-time hashes, verifies while the file is unchanged,
// and is refused by the firewall once it changes, exactly like a Read-tool
// memory. Incomplete evidence (another command in the chain) records the
// files for staleness but never reads as verified.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreMemory } from "../src/state/store-memory.js";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import { classifyProvenance } from "../src/functions/verify.js";
import type { CompressedObservation } from "../src/functions/types.js";
import { __resetGitIdentityCache } from "../src/functions/git-identity.js";

let sdk: Kernel;
let kv: StateKV;
let repo: string;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-shellprov" }, { store: new StoreMemory() });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  repo = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-shell-")));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const ROTATE_MS = 900_000;\nexport const A = 1;\n");
  writeFileSync(join(repo, "src", "b.ts"), "export const B = 2;\n");
});

afterEach(() => {
  __resetKernelSingleton();
  rmSync(repo, { recursive: true, force: true });
});

async function capture(
  toolInput: Record<string, unknown>,
  toolName = "Bash",
  agent?: string,
): Promise<CompressedObservation> {
  const r = await sdk.trigger<unknown, { observationId: string }>({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId: "s-shell",
      project: repo,
      cwd: repo,
      timestamp: new Date().toISOString(),
      ...(agent ? { agent } : {}),
      data: { tool_name: toolName, tool_input: toolInput, tool_output: { stdout: "export const ROTATE_MS = 900_000;" } },
    },
  });
  const obs = await kv.get<CompressedObservation>(KV.observations("s-shell"), r.observationId);
  return obs!;
}

describe("shell reads carry verifiable file evidence", () => {
  it("a `sed -n` read verifies while the file is unchanged, and goes stale when it changes", async () => {
    const obs = await capture({ command: "sed -n '1,2p' src/a.ts" });
    expect(obs.provenance?.files).toEqual(["src/a.ts"]);
    expect(obs.provenance?.fileHashes?.["src/a.ts"]).toMatch(/^[0-9a-f]{64}$/);
    expect(obs.provenance?.mixedTrust).toBeUndefined();
    expect(classifyProvenance(obs.provenance, repo).status).toBe("verified");

    writeFileSync(join(repo, "src", "a.ts"), "export const ROTATE_MS = 3_600_000;\n");
    expect(classifyProvenance(obs.provenance, repo).status).toBe("stale");
  });

  it("the firewall refuses the stale shell-read memory at recall", async () => {
    await capture({ command: "cat src/a.ts" });
    const before = await sdk.trigger<unknown, { results: unknown[] }>({
      function_id: "mem::search",
      payload: { query: "ROTATE_MS", cwd: repo, project: repo, safe_only: true, limit: 5 },
    });
    expect(before.results.length).toBeGreaterThan(0);

    writeFileSync(join(repo, "src", "a.ts"), "export const ROTATE_MS = 3_600_000;\n");
    const after = await sdk.trigger<unknown, { results: unknown[]; firewall?: { refused?: number } }>({
      function_id: "mem::search",
      payload: { query: "ROTATE_MS", cwd: repo, project: repo, safe_only: true, limit: 5 },
    });
    expect(after.results.length).toBe(0);
    expect(after.firewall?.refused ?? 0).toBeGreaterThan(0);
  });

  it("incomplete evidence records the file for drift but never verifies", async () => {
    const obs = await capture({ command: "npm test && cat src/b.ts" });
    expect(obs.provenance?.files).toEqual(["src/b.ts"]);
    expect(obs.provenance?.mixedTrust).toBe(true);
    expect(classifyProvenance(obs.provenance, repo).status).toBe("sourced_unverified");
    writeFileSync(join(repo, "src", "b.ts"), "export const B = 3;\n");
    expect(classifyProvenance(obs.provenance, repo).status).toBe("stale");
  });

  it("a directory search or a missing file adds no evidence", async () => {
    const dir = await capture({ command: "grep -rn ROTATE_MS src" });
    expect(dir.provenance?.files).toBeUndefined();
    expect(classifyProvenance(dir.provenance, repo).status).toBe("sourced_unverified");
    const missing = await capture({ command: "cat src/nope.ts" });
    expect(missing.provenance?.files).toBeUndefined();
  });

  it("Codex shapes: an argv command with a workdir resolves there, and the workdir is not a file", async () => {
    const obs = await capture(
      { command: ["bash", "-lc", "sed -n 1,2p a.ts"], workdir: join(repo, "src") },
      "exec_command",
      "codex",
    );
    expect(obs.provenance?.files).toEqual(["src/a.ts"]);
    expect(classifyProvenance(obs.provenance, repo).status).toBe("verified");
  });

  it("a command that writes (sed -i) is not a read", async () => {
    const obs = await capture({ command: "sed -i 's/1/2/' src/b.ts" });
    expect(obs.provenance?.files).toBeUndefined();
  });

  // --- review findings, end to end ---------------------------------------

  it("a candidate missing at capture caps the memory (it used to vanish and leave `verified`)", async () => {
    const obs = await capture({ command: "cat src/a.ts src/local.ts" });
    expect(obs.provenance?.files).toEqual(["src/a.ts"]);
    expect(obs.provenance?.mixedTrust).toBe(true);
    expect(classifyProvenance(obs.provenance, repo).status).toBe("sourced_unverified");
  });

  it("a directory next to a file caps the memory", async () => {
    const obs = await capture({ command: "grep -rn ROTATE src src/a.ts" });
    expect(obs.provenance?.files).toEqual(["src/a.ts"]);
    expect(obs.provenance?.mixedTrust).toBe(true);
  });

  it("a file named by an option (grep -f) is evidence: changing it makes the memory stale", async () => {
    writeFileSync(join(repo, "pats.txt"), "ROTATE_MS\n");
    const obs = await capture({ command: "grep -f pats.txt src/a.ts" });
    expect(obs.provenance?.files?.sort()).toEqual(["pats.txt", "src/a.ts"]);
    expect(classifyProvenance(obs.provenance, repo).status).toBe("verified");
    writeFileSync(join(repo, "pats.txt"), "export\n");
    expect(classifyProvenance(obs.provenance, repo).status).toBe("stale");
  });

  it("a relative Codex workdir and a Gemini dir_path resolve against the session cwd", async () => {
    const codex = await capture({ command: ["bash", "-lc", "cat a.ts"], workdir: "src" }, "exec_command", "codex");
    expect(codex.provenance?.files).toEqual(["src/a.ts"]);
    expect(classifyProvenance(codex.provenance, repo).status).toBe("verified");
    const gemini = await capture({ command: "cat b.ts", dir_path: "src" }, "run_shell_command", "gemini");
    expect(gemini.provenance?.files).toEqual(["src/b.ts"]);
  });

  it("a generic `exec` tool from a host that is not known to own it is not a local shell", async () => {
    // e.g. a Gemini CLI MCP server surfacing a remote-exec tool as bare `exec`
    const obs = await capture({ host: "prod-1", command: "cat src/a.ts" }, "exec", "gemini");
    expect(obs.provenance?.files).toBeUndefined();
  });

  it("a remote-exec MCP tool is never vouched for by local files", async () => {
    const ssh = await capture({ host: "prod", command: "cat src/a.ts" }, "mcp__ssh__exec");
    expect(ssh.provenance?.files).toBeUndefined();
    expect(classifyProvenance(ssh.provenance, repo).status).not.toBe("verified");
  });

  it("a relative cd yields no evidence rather than a guess", async () => {
    const obs = await capture({ command: "cd src && cat a.ts" });
    expect(obs.provenance?.files).toBeUndefined();
  });

  it("a capture from a subdirectory re-roots at the checkout, not at the caller's cwd", async () => {
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "packages", "foo"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"root"}\n');
    writeFileSync(join(repo, "packages", "foo", "package.json"), '{"name":"foo"}\n');
    __resetGitIdentityCache();
    const sub = join(repo, "packages", "foo");
    const r = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "s-sub",
        project: sub,
        cwd: sub,
        timestamp: new Date().toISOString(),
        data: { tool_name: "Bash", tool_input: { command: "cat package.json" }, tool_output: '{"name":"foo"}' },
      },
    });
    const obs = (await kv.get<CompressedObservation>(KV.observations("s-sub"), r.observationId))!;
    expect(obs.provenance?.files).toEqual(["package.json"]);
    expect(obs.provenance?.cwdInRepo).toBe(join("packages", "foo"));

    // recalled from the repo ROOT of the same project
    const fromRoot = () => classifyProvenance(obs.provenance, repo, { verifyAgainstRoot: true });
    expect(fromRoot().status).toBe("verified");
    writeFileSync(join(repo, "package.json"), '{"name":"root","v":2}\n'); // a DIFFERENT file
    expect(fromRoot().status).toBe("verified");
    writeFileSync(join(sub, "package.json"), '{"name":"foo","v":2}\n'); // the file it read
    expect(fromRoot().status).toBe("stale");
  });

  it("absolute evidence inside the checkout but outside the capture cwd re-roots at the caller's worktree", async () => {
    const main = join(repo, "main");
    const wt = join(repo, "wt");
    for (const top of [main, wt]) {
      mkdirSync(join(top, "src"), { recursive: true });
      mkdirSync(join(top, "packages", "foo"), { recursive: true });
      writeFileSync(join(top, "src", "x.ts"), "export const QUOKKA = 1;\n");
    }
    mkdirSync(join(main, ".git"));
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    __resetGitIdentityCache();
    const sub = join(main, "packages", "foo");
    const r = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "s-wt",
        project: sub,
        cwd: sub,
        timestamp: new Date().toISOString(),
        data: { tool_name: "Read", tool_input: { file_path: join(main, "src", "x.ts") }, tool_output: "QUOKKA" },
      },
    });
    const obs = (await kv.get<CompressedObservation>(KV.observations("s-wt"), r.observationId))!;
    expect(obs.provenance?.files).toEqual([join(main, "src", "x.ts")]);
    expect(obs.provenance?.cwdInRepo).toBe(join("packages", "foo"));

    const fromWt = () => classifyProvenance(obs.provenance, wt, { verifyAgainstRoot: true });
    expect(fromWt().status).toBe("verified");
    writeFileSync(join(main, "src", "x.ts"), "export const QUOKKA = 2;\n"); // the OTHER worktree
    expect(fromWt().status).toBe("verified");
    writeFileSync(join(wt, "src", "x.ts"), "export const QUOKKA = 3;\n"); // this worktree's copy
    expect(fromWt().status).toBe("stale");
  });

  it("a hostile cwdInRepo (absolute or climbing) is ignored", () => {
    mkdirSync(join(repo, ".git"));
    __resetGitIdentityCache();
    const hash = classifyProvenance(
      { files: ["src/a.ts"], fileHashes: {}, cwd: repo, userConfirmed: false },
      repo,
    );
    expect(hash.status).toBe("sourced_unverified");
    for (const bad of ["../..", "/etc", "a/../../b"]) {
      const v = classifyProvenance(
        { files: ["a.ts"], fileHashes: { "a.ts": "0".repeat(64) }, cwd: join(repo, "src"), cwdInRepo: bad, userConfirmed: false },
        repo,
        { verifyAgainstRoot: true },
      );
      // falls back to the caller root: repo/a.ts does not exist -> stale, never an escape
      expect(v.status).toBe("stale");
    }
  });
});

