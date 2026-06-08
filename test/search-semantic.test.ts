//
// Regression guard for the bug the live smoke test caught: mem::search must
// actually consult the vector index, not BM25 only. Uses a controlled stub
// embedding model where related concepts share a vector axis but NO words,
// so a hit can ONLY come from the semantic stream — never keyword overlap.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import {
  registerCoreFunctions,
  getSearchIndex,
  setEmbeddingProvider,
  setVectorIndex,
} from "../src/functions/index.js";
import { VectorIndex } from "../src/functions/vector-index.js";
import type { EmbeddingProvider } from "../src/functions/types.js";

const DIMS = 16;

// Concept -> axis. Words in a group map to the same unit vector, so two
// texts that share a CONCEPT are near each other even with zero shared words.
const GROUPS: Array<{ axis: number; words: string[] }> = [
  { axis: 0, words: ["iam", "login", "credential", "credentials", "token", "tokens", "auth", "password"] },
  { axis: 1, words: ["pod", "pods", "container", "containers", "memory", "oom", "kubernetes"] },
  { axis: 2, words: ["postgres", "database", "query", "queries", "sql", "pool"] },
];

function stubProvider(): EmbeddingProvider {
  const embed = (text: string): Float32Array => {
    const v = new Float32Array(DIMS);
    const lw = text.toLowerCase();
    let matched = false;
    for (const g of GROUPS) {
      if (g.words.some((w) => lw.includes(w))) {
        v[g.axis] = 1;
        matched = true;
      }
    }
    if (!matched) v[DIMS - 1] = 1;
    return v;
  };
  return {
    name: "stub",
    dimensions: DIMS,
    embed: (t) => Promise.resolve(embed(t)),
    embedBatch: (ts) => Promise.resolve(ts.map(embed)),
  };
}

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-sem" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  setVectorIndex(null);
  setEmbeddingProvider(null);
  __resetKernelSingleton();
});

// Distinct tool_input per call so the observe dedup (hashes
// sessionId+tool+input over a 5-min window) doesn't suppress the second.
async function observe(output: string, file: string) {
  return sdk.trigger<unknown, { observationId?: string }>({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId: "s1",
      project: "/demo",
      cwd: "/demo",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Edit", tool_input: { file }, tool_output: output },
    },
  });
}

async function search(query: string) {
  const r = await sdk.trigger<unknown, { results?: Array<{ observation: { narrative: string } }> }>({
    function_id: "mem::search",
    payload: { query },
  });
  return r.results ?? [];
}

describe("mem::search consults the semantic stream", () => {
  it("finds a memory by MEANING when no keyword overlaps (vector stream)", async () => {
    setEmbeddingProvider(stubProvider());
    setVectorIndex(new VectorIndex());

    await observe("migrated login to IAM bearer tokens", "auth.ts");
    await observe("the inference pods were OOMKilled, raised memory limit", "deploy.yaml");

    // "credentials" shares the auth CONCEPT but appears in neither memory's
    // text — BM25 cannot match it; only the vector stream can.
    const hits = await search("user credentials handling");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.observation.narrative.toLowerCase()).toMatch(/iam|login|token/);
  });

  it("routes a different concept to the right memory", async () => {
    setEmbeddingProvider(stubProvider());
    setVectorIndex(new VectorIndex());
    await observe("migrated login to IAM bearer tokens", "auth.ts");
    await observe("the inference pods were OOMKilled, raised memory limit", "deploy.yaml");

    const hits = await search("why do my containers keep dying");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.observation.narrative.toLowerCase()).toMatch(/pod|oom|memory/);
  });

  it("without a provider, the keyword-absent query finds nothing (proves it was the vector stream)", async () => {
    // No provider/vector index set -> pure BM25.
    await observe("migrated login to IAM bearer tokens", "auth.ts");
    const hits = await search("user credentials handling");
    expect(hits.length).toBe(0);
  });

  it("narrative search returns the packed block under `text` (SessionStart hook contract)", async () => {
    await observe("migrated login to IAM bearer tokens", "auth.ts");
    const r = await sdk.trigger<unknown, { text?: string }>({
      function_id: "mem::search",
      payload: { query: "IAM", format: "narrative" },
    });
    // The SessionStart hook reads response.text — guard it can't drift.
    expect(typeof r.text).toBe("string");
    expect(r.text!.toLowerCase()).toContain("iam");
  });
});
