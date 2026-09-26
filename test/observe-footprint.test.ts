//
// The write path must not leave unbounded tool output in the append-only
// oplog. mem::observe used to persist the full raw observation (the whole
// tool output, twice: raw and toolOutput) and then overwrite it with the
// synthetic memory under the same id. The overwrite fixed the live row, but
// the oplog kept the raw version forever: a 10MB PDF read became a 20MB
// history entry, and raw payloads were 1.2GB of one real brain's 1.35GB.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreMemory } from "../src/state/store-memory.js";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";

describe("observe keeps the oplog bounded", () => {
  let sdk: Kernel;
  let kv: StateKV;
  let store: StoreMemory;

  beforeEach(() => {
    __resetKernelSingleton();
    getSearchIndex().clear();
    store = new StoreMemory();
    sdk = registerWorker("in-process", { workerName: "memwarden-footprint" }, { store });
    kv = new StateKV(sdk);
    registerCoreFunctions(sdk, kv);
  });

  afterEach(() => {
    __resetKernelSingleton();
  });

  const TAIL = "TAIL-NEEDLE-zq9-never-stored";
  const hugeOutput = `%PDF-1.3 ${"JVBERi0xLjMKJcTl8uXrp".repeat(60_000)} ${TAIL}`;

  async function observe(sessionId: string, hookType: string, data: unknown): Promise<string> {
    const r = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType,
        sessionId,
        project: "/work/proj",
        cwd: "/work/proj",
        timestamp: new Date().toISOString(),
        data,
      },
    });
    return r.observationId;
  }

  it("a huge tool output never reaches the oplog; only the bounded synthetic does", async () => {
    expect(hugeOutput.length).toBeGreaterThan(1_000_000);
    const id = await observe("s1", "post_tool_use", {
      tool_name: "Read",
      tool_input: { file_path: "/work/proj/docs/big.pdf" },
      tool_output: { type: "pdf", file: { filePath: "/work/proj/docs/big.pdf", base64: hugeOutput } },
    });

    const log = await store.readOplog();
    const obsEntries = log.filter((e) => e.scope === KV.observations("s1"));
    // exactly one write for the observation: the synthetic, not raw-then-synthetic
    expect(obsEntries.filter((e) => e.key === id).length).toBe(1);
    const biggest = Math.max(...log.map((e) => JSON.stringify(e.payload ?? null).length));
    expect(biggest).toBeLessThan(64_000);
    expect(JSON.stringify(log)).not.toContain(TAIL);

    // the live record is the searchable synthetic memory
    const stored = await kv.get<{ title?: string }>(KV.observations("s1"), id);
    expect(stored?.title).toBeTruthy();
  });

  it("session_end writes only the handoff, including on a refreshed stop", async () => {
    await observe("s2", "post_tool_use", {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_output: "all 12 tests passed",
    });
    const first = await observe("s2", "session_end", { assistant_response: `done ${hugeOutput}` });
    const second = await observe("s2", "session_end", { assistant_response: "done again" });
    expect(second).toBe(first); // per-turn stops refresh the same handoff slot

    const log = await store.readOplog();
    expect(JSON.stringify(log)).not.toContain(TAIL);
    const rows = await kv.list<{ id: string }>(KV.observations("s2"));
    expect(rows.map((r) => r.id).sort()).toHaveLength(2); // tool capture + one handoff
  });
});
