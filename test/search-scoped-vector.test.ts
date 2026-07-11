//
// Scope-aware vector search: when mem::search carries a project/cwd filter,
// the vector stream runs an allowlist search over in-scope ids instead of a
// global top-k that mostly gets post-filtered away. The allowlist is an
// OPTIMIZATION, never a semantics change: the scope post-filter stays on as
// the correctness backstop, and on fixtures the old over-fetch window fully
// covers, both paths must return IDENTICAL result sets.

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
  setVectorIndex,
  getVectorIndex,
  setEmbeddingProvider,
} from "../src/functions/index.js";
import {
  __resetColdRebuildForTests,
  buildScopedAllowedIds,
} from "../src/functions/search.js";
import { SearchIndex } from "../src/functions/search-index.js";
import { VectorIndex } from "../src/functions/vector-index.js";
import { QuantizedVectorIndex } from "../src/functions/quantized-vector-index.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  Memory,
  Session,
} from "../src/functions/types.js";
import { mulberry32, seedFromString } from "../src/functions/turboquant.js";

const DIMS = 64;

// Deterministic embeddings with a shared "topic" axis: every doc about the
// same topic lands near the query, ACROSS projects — so a global vector scan
// ranks out-of-scope docs high and the scope machinery has real work to do.
function embedSync(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  const lw = text.toLowerCase();
  if (lw.includes("auth") || lw.includes("login") || lw.includes("credential")) {
    v[0] = 1;
  } else if (lw.includes("database") || lw.includes("postgres")) {
    v[1] = 1;
  } else {
    v[DIMS - 1] = 1;
  }
  // Small deterministic per-text noise so ranks are stable but distinct.
  const prng = mulberry32(seedFromString(text));
  for (let i = 2; i < 10; i++) v[i] = 0.05 * (prng() - 0.5);
  return v;
}

function stubProvider(): EmbeddingProvider {
  return {
    name: "stub",
    dimensions: DIMS,
    embed: (t) => Promise.resolve(embedSync(t)),
    embedBatch: (ts) => Promise.resolve(ts.map(embedSync)),
  };
}

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  __resetColdRebuildForTests();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-scoped" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  setEmbeddingProvider(stubProvider());
  setVectorIndex(new VectorIndex());
});

afterEach(() => {
  delete process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH;
  setVectorIndex(null);
  setEmbeddingProvider(null);
  __resetKernelSingleton();
});

function session(id: string, project: string, projectKey?: string): Session {
  return {
    id,
    project,
    cwd: project,
    ...(projectKey !== undefined ? { projectKey } : {}),
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
    facts: [text],
    narrative: text,
    concepts: [],
    files: [],
    importance: 0.5,
  };
}

function memory(id: string, title: string, project?: string): Memory {
  return {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "fact",
    title,
    content: `${title} content`,
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 0.8,
    version: 1,
    isLatest: true,
    ...(project !== undefined ? { project } : {}),
  };
}

/** Mixed-project fixture: same TOPIC in two projects, so the vector stream
 * ranks out-of-scope docs just as high as in-scope ones. */
async function seedMixedProjects(): Promise<void> {
  await kv.set(KV.sessions, "sA", session("sA", "/projA"));
  await kv.set(KV.sessions, "sB", session("sB", "/projB"));
  for (let i = 0; i < 4; i++) {
    await kv.set(
      KV.observations("sA"),
      `a-${i}`,
      obs(`a-${i}`, "sA", `auth login flow note ${i} in projA`),
    );
    await kv.set(
      KV.observations("sB"),
      `b-${i}`,
      obs(`b-${i}`, "sB", `auth login flow note ${i} in projB`),
    );
  }
}

async function searchIds(payload: Record<string, unknown>): Promise<string[]> {
  const r = await sdk.trigger<
    unknown,
    { results?: Array<{ observation: { id: string } }> }
  >({
    function_id: "mem::search",
    payload,
  });
  return (r.results ?? []).map((x) => x.observation.id);
}

describe("backend searchAllowed parity (filter-during-scan == global-then-filter)", () => {
  const N = 200;
  const texts = Array.from({ length: N }, (_, i) => `auth credential doc ${i}`);
  const allowed = new Set(
    Array.from({ length: N }, (_, i) => `obs-${i}`).filter((_, i) => i % 7 === 0),
  );
  const query = embedSync("auth login");

  it("VectorIndex: identical ids and order vs post-filtered global scan", () => {
    const idx = new VectorIndex();
    for (let i = 0; i < N; i++) idx.add(`obs-${i}`, "s", embedSync(texts[i]!));
    const viaAllowlist = idx.searchAllowed(query, 10, allowed).map((h) => h.obsId);
    const viaPostFilter = idx
      .search(query, N)
      .filter((h) => allowed.has(h.obsId))
      .slice(0, 10)
      .map((h) => h.obsId);
    expect(viaAllowlist).toEqual(viaPostFilter);
    expect(viaAllowlist.length).toBe(10);
    for (const id of viaAllowlist) expect(allowed.has(id)).toBe(true);
  });

  it("QuantizedVectorIndex: identical ids vs post-filtered global scan; array allowlist accepted", () => {
    const idx = new QuantizedVectorIndex({
      dims: DIMS,
      bits: 4,
      seed: "scoped-test",
      rescoreDepth: 0,
    });
    for (let i = 0; i < N; i++) idx.add(`obs-${i}`, "s", embedSync(texts[i]!));
    const viaAllowlist = idx.searchAllowed(query, 10, allowed).map((h) => h.obsId);
    const viaPostFilter = idx
      .search(query, N)
      .filter((h) => allowed.has(h.obsId))
      .slice(0, 10)
      .map((h) => h.obsId);
    expect(viaAllowlist).toEqual(viaPostFilter);
    for (const id of viaAllowlist) expect(allowed.has(id)).toBe(true);
    // The contract accepts arrays too (the turbovec tests use them).
    expect(idx.searchAllowed(query, 10, [...allowed]).map((h) => h.obsId)).toEqual(
      viaAllowlist,
    );
  });

  it("empty and unknown allowlists return []", () => {
    const idx = new VectorIndex();
    idx.add("obs-1", "s", embedSync("auth"));
    expect(idx.searchAllowed(query, 10, new Set())).toEqual([]);
    expect(idx.searchAllowed(query, 10, ["ghost"])).toEqual([]);
    const q = new QuantizedVectorIndex({ dims: DIMS, bits: 4, seed: "s", rescoreDepth: 0 });
    q.add("obs-1", "s", embedSync("auth"));
    expect(q.searchAllowed(query, 10, new Set())).toEqual([]);
  });
});

describe("mem::search scoped vector stream", () => {
  it("project-filtered search returns identical result sets with the allowlist on and off", async () => {
    await seedMixedProjects();

    // OFF first (the old global-then-postfilter path)…
    process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH = "off";
    const oldPath = await searchIds({ query: "user credentials", project: "/projA" });
    // …then ON (the allowlist path) against the same live indexes.
    delete process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH;
    const newPath = await searchIds({ query: "user credentials", project: "/projA" });

    expect(oldPath.length).toBeGreaterThan(0);
    expect([...newPath].sort()).toEqual([...oldPath].sort());
    // And zero out-of-scope results on either path.
    for (const id of newPath) expect(id.startsWith("a-")).toBe(true);
    for (const id of oldPath) expect(id.startsWith("a-")).toBe(true);
  });

  it("cwd-filtered search: same parity and zero out-of-scope results", async () => {
    await seedMixedProjects();

    process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH = "off";
    const oldPath = await searchIds({ query: "user credentials", cwd: "/projB" });
    delete process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH;
    const newPath = await searchIds({ query: "user credentials", cwd: "/projB" });

    expect(oldPath.length).toBeGreaterThan(0);
    expect([...newPath].sort()).toEqual([...oldPath].sort());
    for (const id of newPath) expect(id.startsWith("b-")).toBe(true);
  });

  it("unfiltered search is untouched by the allowlist machinery", async () => {
    await seedMixedProjects();
    const ids = await searchIds({ query: "user credentials" });
    // Both projects visible without a filter.
    expect(ids.some((id) => id.startsWith("a-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("b-"))).toBe(true);
  });

  it("memories (no live session) survive the allowlist: project match and null-project pass, other-project drops", async () => {
    await seedMixedProjects();
    await kv.set(KV.memories, "m-a", memory("m-a", "auth memory for projA", "/projA"));
    await kv.set(KV.memories, "m-b", memory("m-b", "auth memory for projB", "/projB"));
    await kv.set(KV.memories, "m-null", memory("m-null", "auth memory no project"));

    process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH = "off";
    const oldPath = await searchIds({
      query: "user credentials",
      project: "/projA",
      limit: 20,
    });
    delete process.env.MEMWARDEN_SCOPED_VECTOR_SEARCH;
    const newPath = await searchIds({
      query: "user credentials",
      project: "/projA",
      limit: 20,
    });

    expect([...newPath].sort()).toEqual([...oldPath].sort());
    expect(newPath).toContain("m-a"); // matching project
    expect(newPath).toContain("m-null"); // unknown project passes (back-compat)
    expect(newPath).not.toContain("m-b"); // other project firewalled
  });

  it("actually takes the allowlist path when filtering (guard against silent fallback)", async () => {
    await seedMixedProjects();
    const vIdx = getVectorIndex() as VectorIndex & {
      searchAllowedCalls?: number;
      searchCalls?: number;
    };
    vIdx.searchAllowedCalls = 0;
    vIdx.searchCalls = 0;
    const origAllowed = vIdx.searchAllowed.bind(vIdx);
    const origSearch = vIdx.search.bind(vIdx);
    vIdx.searchAllowed = (q, k, a) => {
      vIdx.searchAllowedCalls!++;
      return origAllowed(q, k, a);
    };
    vIdx.search = (q, k) => {
      vIdx.searchCalls!++;
      return origSearch(q, k);
    };

    await searchIds({ query: "user credentials", project: "/projA" });
    expect(vIdx.searchAllowedCalls).toBe(1);
    expect(vIdx.searchCalls).toBe(0);

    // Unfiltered search uses the global scan.
    await searchIds({ query: "user credentials" });
    expect(vIdx.searchCalls).toBe(1);
    expect(vIdx.searchAllowedCalls).toBe(1);
  });

  it("filter matching nothing returns no vector leakage", async () => {
    await seedMixedProjects();
    const ids = await searchIds({ query: "user credentials", project: "/nowhere" });
    expect(ids).toEqual([]);
  });
});

describe("buildScopedAllowedIds", () => {
  it("mirrors the post-filter predicate: canonical path match, projectKey widening, memory superset", async () => {
    await kv.set(KV.sessions, "sA", session("sA", "/projA"));
    await kv.set(KV.sessions, "sB", session("sB", "/projB"));
    // Widened session: DIFFERENT path, same stable projectKey.
    await kv.set(KV.sessions, "sW", session("sW", "/elsewhere/worktree", "key-A"));

    const idx = new SearchIndex();
    idx.add(obs("a-1", "sA", "auth note"));
    idx.add(obs("b-1", "sB", "auth note b"));
    idx.add(obs("w-1", "sW", "auth note widened"));
    idx.add(obs("m-1", "memory", "auth memory")); // no live session

    const { allowed } = await buildScopedAllowedIds(kv, idx, {
      projectFilter: "/projA",
      cwdFilter: undefined,
      projectFilterKey: "key-A",
      cwdFilterKey: null,
    });

    expect(allowed.has("a-1")).toBe(true); // exact path
    expect(allowed.has("w-1")).toBe(true); // widened by projectKey
    expect(allowed.has("m-1")).toBe(true); // memory superset (post-filter decides)
    expect(allowed.has("b-1")).toBe(false); // out of scope
  });

  it("session map stays consistent through remove and clear", () => {
    const idx = new SearchIndex();
    idx.add(obs("x-1", "s1", "one"));
    idx.add(obs("x-2", "s1", "two"));
    idx.add(obs("y-1", "s2", "three"));
    expect([...idx.idsForSession("s1")!].sort()).toEqual(["x-1", "x-2"]);
    idx.remove("x-1");
    expect([...idx.idsForSession("s1")!]).toEqual(["x-2"]);
    idx.remove("x-2");
    expect(idx.idsForSession("s1")).toBeUndefined();
    expect(idx.indexedSessionIds()).toEqual(["s2"]);
    idx.clear();
    expect(idx.indexedSessionIds()).toEqual([]);
  });

  it("session map survives serialize/deserialize and restoreFrom", () => {
    const idx = new SearchIndex();
    idx.add(obs("x-1", "s1", "one"));
    idx.add(obs("y-1", "s2", "two"));
    const round = SearchIndex.deserialize(idx.serialize());
    expect([...round.idsForSession("s1")!]).toEqual(["x-1"]);
    expect([...round.idsForSession("s2")!]).toEqual(["y-1"]);
    const restored = new SearchIndex();
    restored.restoreFrom(idx);
    expect([...restored.idsForSession("s1")!]).toEqual(["x-1"]);
  });
});
