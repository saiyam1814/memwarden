//
// Cold-rebuild timing: sequential per-doc embeds (the old rebuildIndex path)
// vs batched embedBatch chunks (the current path) over ~2K synthetic docs.
//
// The embedding provider is synthetic and models the measured shape of the
// real local MiniLM pipeline: a fixed per-call overhead (tokenizer/session
// dispatch, dominant for short docs) plus a per-item cost. The point of the
// comparison is the CALL COUNT collapse (2000 embed() calls -> 32 embedBatch
// calls at chunk size 64); the modeled milliseconds make that visible as
// wall time. Both paths run against the same in-memory KV fixture through
// the real rebuildIndex/vectorIndexAddGuarded code.
//
// Run: npx tsx benchmark/cold-rebuild.ts

import { performance } from "node:perf_hooks";
import { registerWorker, __resetKernelSingleton } from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  getSearchIndex,
  setVectorIndex,
  setEmbeddingProvider,
  rebuildIndex,
  vectorIndexAddGuarded,
} from "../src/functions/index.js";
import { EMBED_BATCH_SIZE } from "../src/functions/search.js";
import { VectorIndex } from "../src/functions/vector-index.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  Memory,
  Session,
} from "../src/functions/types.js";
import { mulberry32, seedFromString } from "../src/functions/turboquant.js";

const DIMS = 384;
const N_DOCS = 2000;
const N_SESSIONS = 20;

// Modeled provider costs (ms). PER_CALL dominates for short docs on the real
// WASM MiniLM pipeline; batching pays it once per chunk instead of per doc.
const PER_CALL_MS = 4;
const PER_ITEM_MS = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeProvider(): EmbeddingProvider & { calls: { embed: number; batch: number } } {
  const embedSync = (text: string): Float32Array => {
    const prng = mulberry32(seedFromString(text));
    return Float32Array.from({ length: DIMS }, () => prng() - 0.5);
  };
  const calls = { embed: 0, batch: 0 };
  return {
    name: "modeled-minilm",
    dimensions: DIMS,
    calls,
    async embed(text: string): Promise<Float32Array> {
      calls.embed++;
      await sleep(PER_CALL_MS + PER_ITEM_MS);
      return embedSync(text);
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      calls.batch++;
      await sleep(PER_CALL_MS + PER_ITEM_MS * texts.length);
      return texts.map(embedSync);
    },
  };
}

async function seed(kv: StateKV): Promise<void> {
  for (let s = 0; s < N_SESSIONS; s++) {
    const sid = `sess-${s}`;
    const session: Session = {
      id: sid,
      project: `/work/proj-${s % 5}`,
      cwd: `/work/proj-${s % 5}`,
      startedAt: new Date().toISOString(),
      status: "completed",
      observationCount: 0,
    };
    await kv.set(KV.sessions, sid, session);
  }
  for (let i = 0; i < N_DOCS; i++) {
    const sid = `sess-${i % N_SESSIONS}`;
    const obs: CompressedObservation = {
      id: `obs-${i}`,
      sessionId: sid,
      timestamp: new Date().toISOString(),
      type: "discovery",
      title: `synthetic doc ${i}`,
      facts: [`fact about topic ${i % 97}`],
      narrative: `narrative body for synthetic doc ${i}, topic ${i % 97}`,
      concepts: [],
      files: [],
      importance: 0.5,
    };
    await kv.set(KV.observations(sid), obs.id, obs);
  }
}

/** The pre-batching rebuild loop: one guarded embed() round-trip per doc. */
async function sequentialRebuild(kv: StateKV): Promise<void> {
  const idx = getSearchIndex();
  idx.clear();
  const memories = await kv.list<Memory>(KV.memories);
  for (const m of memories) {
    if (m.isLatest === false || !m.title || !m.content) continue;
    await vectorIndexAddGuarded(m.id, m.sessionIds?.[0] ?? "memory", m.title + " " + m.content, {
      kind: "memory",
      logId: m.id,
    });
  }
  const sessions = await kv.list<Session>(KV.sessions);
  for (const s of sessions) {
    const observations = await kv.list<CompressedObservation>(KV.observations(s.id));
    for (const obs of observations) {
      if (!obs.title || !obs.narrative) continue;
      idx.add(obs);
      await vectorIndexAddGuarded(obs.id, obs.sessionId, obs.title + " " + obs.narrative, {
        kind: "observation",
        logId: obs.id,
      });
    }
  }
}

async function main(): Promise<void> {
  __resetKernelSingleton();
  const sdk = registerWorker("in-process", { workerName: "memwarden-bench" }, {
    store: new StoreMemory(),
  });
  const kv = new StateKV(sdk);
  await seed(kv);

  console.log(
    `\ncold-rebuild benchmark — ${N_DOCS} docs, ${DIMS}d, chunk ${EMBED_BATCH_SIZE}, ` +
      `modeled embed cost ${PER_CALL_MS}ms/call + ${PER_ITEM_MS}ms/item\n`,
  );

  // BEFORE: sequential per-doc embeds.
  {
    const provider = makeProvider();
    setEmbeddingProvider(provider);
    setVectorIndex(new VectorIndex());
    const t0 = performance.now();
    await sequentialRebuild(kv);
    const ms = performance.now() - t0;
    console.log(
      `  before (per-doc embed):   ${(ms / 1000).toFixed(2)}s   ` +
        `${provider.calls.embed} embed() calls, ${provider.calls.batch} embedBatch() calls`,
    );
  }

  // AFTER: the shipping rebuildIndex, batched.
  {
    const provider = makeProvider();
    setEmbeddingProvider(provider);
    setVectorIndex(new VectorIndex());
    const t0 = performance.now();
    const count = await rebuildIndex(kv);
    const ms = performance.now() - t0;
    console.log(
      `  after  (batched rebuild): ${(ms / 1000).toFixed(2)}s   ` +
        `${provider.calls.embed} embed() calls, ${provider.calls.batch} embedBatch() calls ` +
        `(${count} docs indexed)`,
    );
  }

  setVectorIndex(null);
  setEmbeddingProvider(null);
  console.log();
}

main().catch((err) => {
  console.error("cold-rebuild benchmark failed:", err);
  process.exit(1);
});
