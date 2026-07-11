//
// Scope-aware BM25 (F8): the keyword stream must not run global-top-k +
// post-filter when a project/cwd filter is active — with enough stronger
// out-of-project docs (>= the over-fetch window), a valid in-project result
// gets starved out entirely. With a scope filter, BM25 searches WITHIN the
// same in-scope allowlist the vector stream uses; the post-filter stays on
// as the correctness backstop.

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
} from "../src/functions/index.js";
import { __resetColdRebuildForTests } from "../src/functions/search.js";
import { SearchIndex } from "../src/functions/search-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/functions/types.js";

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  __resetColdRebuildForTests();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-bm25-scope" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  delete process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH;
  __resetKernelSingleton();
});

function session(id: string, project: string): Session {
  return {
    id,
    project,
    cwd: project,
    startedAt: new Date().toISOString(),
    status: "active",
    observationCount: 0,
  };
}

function obs(id: string, sessionId: string, text: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "discovery",
    title: text,
    facts: [],
    narrative: text,
    concepts: [],
    files: [],
    importance: 5,
  };
}

async function searchIds(payload: Record<string, unknown>): Promise<string[]> {
  const r = await sdk.trigger<
    unknown,
    { results?: Array<{ observation: { id: string } }> }
  >({ function_id: "mem::search", payload });
  return (r.results ?? []).map((x) => x.observation.id);
}

describe("SearchIndex allowlist-aware search", () => {
  it("returns only allowed ids; empty allowlist returns []", () => {
    const idx = new SearchIndex();
    idx.add(obs("in-1", "sA", "kubernetes pods crash"));
    idx.add(obs("out-1", "sB", "kubernetes kubernetes kubernetes crash"));
    idx.add(obs("out-2", "sB", "kubernetes crash loop"));

    const scoped = idx.search("kubernetes", 10, new Set(["in-1"]));
    expect(scoped.map((h) => h.obsId)).toEqual(["in-1"]);

    expect(idx.search("kubernetes", 10, new Set())).toEqual([]);

    // Without an allowlist the global behavior is unchanged.
    expect(idx.search("kubernetes", 10).length).toBe(3);
  });

  it("keeps ranking order among allowed docs", () => {
    const idx = new SearchIndex();
    idx.add(obs("weak", "s", "kubernetes and many other unrelated words here"));
    idx.add(obs("strong", "s", "kubernetes kubernetes"));
    idx.add(obs("outside", "s2", "kubernetes kubernetes kubernetes"));
    const hits = idx.search("kubernetes", 10, new Set(["weak", "strong"]));
    expect(hits.map((h) => h.obsId)).toEqual(["strong", "weak"]);
  });
});

describe("mem::search scoped BM25 stream (no vector provider)", () => {
  // Reproduces F8: 150 stronger out-of-project docs exceed the over-fetch
  // window (limit=5 -> fetchLimit=100), so a global-top-k BM25 scan fills
  // every slot with docs the post-filter then kills — starving the one
  // valid in-project result.
  async function seedStarvation(): Promise<void> {
    await kv.set(KV.sessions, "sA", session("sA", "/projA"));
    await kv.set(KV.sessions, "sB", session("sB", "/projB"));
    await kv.set(
      KV.observations("sA"),
      "a-match",
      obs(
        "a-match",
        "sA",
        "the alpha project deploys kubernetes services with helm charts and terraform",
      ),
    );
    for (let i = 0; i < 150; i++) {
      await kv.set(
        KV.observations("sB"),
        `b-${i}`,
        obs(`b-${i}`, "sB", `kubernetes kubernetes crash ${i}`),
      );
    }
  }

  it("a valid in-project result is not starved by 150 stronger out-of-project docs", async () => {
    await seedStarvation();
    const ids = await searchIds({
      query: "kubernetes",
      project: "/projA",
      limit: 5,
    });
    expect(ids).toEqual(["a-match"]);
  });

  it("cwd filter takes the same scoped path", async () => {
    await seedStarvation();
    const ids = await searchIds({
      query: "kubernetes",
      cwd: "/projA",
      limit: 5,
    });
    expect(ids).toEqual(["a-match"]);
  });

  it("parity with the kill switch on fixtures the over-fetch window covers", async () => {
    await kv.set(KV.sessions, "sA", session("sA", "/projA"));
    await kv.set(KV.sessions, "sB", session("sB", "/projB"));
    for (let i = 0; i < 4; i++) {
      await kv.set(
        KV.observations("sA"),
        `a-${i}`,
        obs(`a-${i}`, "sA", `kubernetes note ${i} in projA`),
      );
      await kv.set(
        KV.observations("sB"),
        `b-${i}`,
        obs(`b-${i}`, "sB", `kubernetes note ${i} in projB`),
      );
    }
    process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH = "off";
    const oldPath = await searchIds({ query: "kubernetes", project: "/projA" });
    delete process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH;
    const newPath = await searchIds({ query: "kubernetes", project: "/projA" });
    expect(oldPath.length).toBeGreaterThan(0);
    expect([...newPath].sort()).toEqual([...oldPath].sort());
    for (const id of newPath) expect(id.startsWith("a-")).toBe(true);
  });

  it("unfiltered search is untouched by the allowlist machinery", async () => {
    await seedStarvation();
    const ids = await searchIds({ query: "kubernetes", limit: 10 });
    expect(ids.length).toBe(10);
  });
});
