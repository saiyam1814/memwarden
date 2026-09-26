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

async function capture(toolInput: Record<string, unknown>, toolName = "Bash"): Promise<CompressedObservation> {
  const r = await sdk.trigger<unknown, { observationId: string }>({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId: "s-shell",
      project: repo,
      cwd: repo,
      timestamp: new Date().toISOString(),
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
    );
    expect(obs.provenance?.files).toEqual(["src/a.ts"]);
    expect(classifyProvenance(obs.provenance, repo).status).toBe("verified");
  });

  it("a command that writes (sed -i) is not a read", async () => {
    const obs = await capture({ command: "sed -i 's/1/2/' src/b.ts" });
    expect(obs.provenance?.files).toBeUndefined();
  });
});
