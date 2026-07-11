//
// Unit tests for the turbovec VectorBackend adapter: the string obsId <->
// u64 id mapping, the persistence blob (counter + mapping + tvim bytes),
// and the honest fallback when the native module is absent. The native
// module is MOCKED here (a pure-TS dot-product index with the exact
// interface of native/turbovec-node); the real binding is exercised in
// turbovec-native.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TurbovecBackend,
  createTurbovecBackend,
  type NativeTurbovecModule,
  type NativeTurbovecIndex,
  type NativeSearchHits,
} from "../src/functions/turbovec-backend.js";
import { makeConfiguredVectorIndex } from "../src/functions/search.js";

// --- mock native module ----------------------------------------------------

class MockNativeIndex implements NativeTurbovecIndex {
  vectors = new Map<bigint, Float32Array>();
  readonly dims: number;
  readonly bitWidth: number;

  constructor(dims: number, bitWidth: number) {
    if (dims <= 0 || dims % 8 !== 0) throw new Error("turbovec: dims must be a multiple of 8");
    if (![2, 3, 4].includes(bitWidth)) throw new Error("turbovec: bad bit width");
    this.dims = dims;
    this.bitWidth = bitWidth;
  }

  get len(): number {
    return this.vectors.size;
  }

  addWithIds(vectors: Float32Array, ids: BigUint64Array): void {
    if (vectors.length !== ids.length * this.dims) throw new Error("turbovec: shape mismatch");
    for (const id of ids) {
      if (this.vectors.has(id)) throw new Error(`turbovec: id ${id} already present`);
    }
    for (const v of vectors) {
      if (!Number.isFinite(v)) throw new Error("turbovec: non-finite coordinate");
    }
    for (let i = 0; i < ids.length; i++) {
      this.vectors.set(
        ids[i] as bigint,
        vectors.slice(i * this.dims, (i + 1) * this.dims),
      );
    }
  }

  remove(id: bigint): boolean {
    return this.vectors.delete(id);
  }

  contains(id: bigint): boolean {
    return this.vectors.has(id);
  }

  search(query: Float32Array, k: number, allowlist?: BigUint64Array): NativeSearchHits {
    const allowed = allowlist
      ? new Set<bigint>([...allowlist].filter((id) => this.vectors.has(id)))
      : null;
    const scored: Array<{ id: bigint; score: number }> = [];
    for (const [id, vec] of this.vectors) {
      if (allowed && !allowed.has(id)) continue;
      let dot = 0;
      for (let i = 0; i < this.dims; i++) dot += (query[i] as number) * (vec[i] as number);
      scored.push({ id, score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, k);
    return {
      ids: BigUint64Array.from(top.map((t) => t.id)),
      scores: Float32Array.from(top.map((t) => t.score)),
    };
  }

  save(path: string): void {
    const rows = [...this.vectors.entries()].map(([id, vec]) => [
      id.toString(),
      [...vec],
    ]);
    writeFileSync(path, JSON.stringify({ dims: this.dims, bits: this.bitWidth, rows }));
  }
}

function mockModule(): NativeTurbovecModule & { loads: number } {
  const mod = {
    loads: 0,
    TurbovecIndex: class extends MockNativeIndex {
      static load(path: string): MockNativeIndex {
        mod.loads++;
        const data = JSON.parse(readFileSync(path, "utf8")) as {
          dims: number;
          bits: number;
          rows: Array<[string, number[]]>;
        };
        const idx = new MockNativeIndex(data.dims, data.bits);
        for (const [id, vec] of data.rows) {
          idx.vectors.set(BigInt(id), Float32Array.from(vec));
        }
        return idx;
      }
    },
  };
  return mod as unknown as NativeTurbovecModule & { loads: number };
}

const DIMS = 8;

function vec(...vals: number[]): Float32Array {
  const v = new Float32Array(DIMS);
  vals.forEach((x, i) => (v[i] = x));
  return v;
}

// --- tests -------------------------------------------------------------

let dataDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "memwarden-turbovec-"));
  savedEnv = {
    MEMWARDEN_DATA_DIR: process.env.MEMWARDEN_DATA_DIR,
    MEMWARDEN_VECTOR_BACKEND: process.env.MEMWARDEN_VECTOR_BACKEND,
    MEMWARDEN_QUANT_VECTOR: process.env.MEMWARDEN_QUANT_VECTOR,
  };
  process.env.MEMWARDEN_DATA_DIR = dataDir;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("TurbovecBackend id mapping", () => {
  it("maps obsIds to monotonic native ids and back through search", () => {
    const b = new TurbovecBackend(mockModule(), DIMS, 4);
    b.add("obs-a", "s1", vec(1));
    b.add("obs-b", "s2", vec(0, 1));
    b.add("obs-c", "s1", vec(0.9, 0.1));
    expect(b.size).toBe(3);
    expect(b.backendLabel).toBe("turbovec/native-4bit");

    const hits = b.search(vec(1), 2);
    expect(hits.map((h) => h.obsId)).toEqual(["obs-a", "obs-c"]);
    expect(hits[0]!.sessionId).toBe("s1");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("re-adding an obsId replaces the vector (no duplicate-id error, size stable)", () => {
    const b = new TurbovecBackend(mockModule(), DIMS, 4);
    b.add("obs-a", "s1", vec(1));
    b.add("obs-a", "s1", vec(0, 1)); // would throw IdAlreadyPresent if not replaced
    expect(b.size).toBe(1);
    expect(b.search(vec(0, 1), 1)[0]!.obsId).toBe("obs-a");
  });

  it("remove/has/ids stay consistent and a removed id is never returned", () => {
    const b = new TurbovecBackend(mockModule(), DIMS, 4);
    b.add("obs-a", "s1", vec(1));
    b.add("obs-b", "s1", vec(0, 1));
    b.remove("obs-a");
    expect(b.has("obs-a")).toBe(false);
    expect(b.ids().sort()).toEqual(["obs-b"]);
    expect(b.search(vec(1), 10).map((h) => h.obsId)).toEqual(["obs-b"]);
    b.remove("obs-a"); // second remove is a no-op
    expect(b.size).toBe(1);
  });

  it("soft-skips vectors of the wrong dimension (parity with the TS backends)", () => {
    const b = new TurbovecBackend(mockModule(), DIMS, 4);
    b.add("obs-bad", "s1", new Float32Array(DIMS + 1));
    expect(b.size).toBe(0);
  });

  it("skips non-finite vectors without corrupting the mapping", () => {
    const b = new TurbovecBackend(mockModule(), DIMS, 4);
    b.add("obs-a", "s1", vec(1));
    b.add("obs-nan", "s1", vec(NaN));
    expect(b.size).toBe(1);
    expect(b.has("obs-nan")).toBe(false);
    expect(b.search(vec(1), 10).map((h) => h.obsId)).toEqual(["obs-a"]);
  });

  it("searchAllowed never returns a non-allowed obsId and ignores unknown ids", () => {
    const b = new TurbovecBackend(mockModule(), DIMS, 4);
    b.add("obs-a", "s1", vec(1));
    b.add("obs-b", "s1", vec(0.9, 0.1));
    b.add("obs-c", "s1", vec(0.8, 0.2));
    const hits = b.searchAllowed(vec(1), 10, ["obs-b", "obs-c", "obs-ghost"]);
    expect(hits.map((h) => h.obsId).sort()).toEqual(["obs-b", "obs-c"]);
    expect(b.searchAllowed(vec(1), 10, ["obs-ghost"])).toEqual([]);
    expect(b.searchAllowed(vec(1), 10, [])).toEqual([]);
  });

  it("validateDimensions reports all-or-nothing like the quantized index", () => {
    const b = new TurbovecBackend(mockModule(), DIMS, 4);
    expect(b.validateDimensions(DIMS).seenDimensions.size).toBe(0);
    b.add("obs-a", "s1", vec(1));
    expect(b.validateDimensions(DIMS).mismatches).toEqual([]);
    const bad = b.validateDimensions(DIMS + 8);
    expect(bad.mismatches).toHaveLength(1);
    expect([...bad.seenDimensions]).toEqual([DIMS]);
  });
});

describe("TurbovecBackend persistence blob", () => {
  it("round-trips mapping, sessions and counter through serialize/restoreFromBlob", () => {
    const mod = mockModule();
    const b = new TurbovecBackend(mod, DIMS, 4);
    b.add("obs-a", "s1", vec(1));
    b.add("obs-b", "s2", vec(0, 1));
    b.remove("obs-a"); // burn an id so the counter test is meaningful
    const blob = b.serialize();

    const restored = new TurbovecBackend(mod, DIMS, 4);
    expect(restored.restoreFromBlob(blob)).toBe(true);
    expect(restored.ids().sort()).toEqual(["obs-b"]);
    expect(restored.search(vec(0, 1), 1)[0]).toMatchObject({
      obsId: "obs-b",
      sessionId: "s2",
    });

    // The counter must continue past every previously issued id: adds after
    // restore may never collide with a live native id.
    restored.add("obs-c", "s3", vec(0.5, 0.5));
    const blob2 = JSON.parse(restored.serialize()) as {
      counter: string;
      entries: Array<[string, { id: string }]>;
    };
    const ids = blob2.entries.map(([, e]) => BigInt(e.id));
    expect(new Set(ids.map(String)).size).toBe(ids.length);
    for (const id of ids) expect(BigInt(blob2.counter) > id).toBe(true);
  });

  it("rejects corrupt or mismatched blobs and leaves the backend empty", () => {
    const mod = mockModule();
    const b = new TurbovecBackend(mod, DIMS, 4);
    b.add("obs-a", "s1", vec(1));
    const good = b.serialize();

    const fresh = () => new TurbovecBackend(mod, DIMS, 4);
    expect(fresh().restoreFromBlob("not json")).toBe(false);
    expect(fresh().restoreFromBlob(JSON.stringify({ backend: "quant" }))).toBe(false);

    // dims/bits drift
    const other = new TurbovecBackend(mod, DIMS * 2, 4);
    expect(other.restoreFromBlob(good)).toBe(false);
    const otherBits = new TurbovecBackend(mod, DIMS, 2);
    expect(otherBits.restoreFromBlob(good)).toBe(false);

    // id-table tamper: mapping points at a native id the index doesn't hold
    const tampered = JSON.parse(good) as { entries: Array<[string, { id: string; s: string }]> };
    tampered.entries[0]![1].id = "999999";
    const t = fresh();
    expect(t.restoreFromBlob(JSON.stringify(tampered))).toBe(false);
    expect(t.size).toBe(0);

    // missing mapping row for a native vector
    const dropped = JSON.parse(good) as { entries: unknown[] };
    dropped.entries = [];
    expect(fresh().restoreFromBlob(JSON.stringify(dropped))).toBe(false);
  });

  it("clear() empties the index but keeps issuing fresh ids", () => {
    const mod = mockModule();
    const b = new TurbovecBackend(mod, DIMS, 4);
    b.add("obs-a", "s1", vec(1));
    b.clear();
    expect(b.size).toBe(0);
    b.add("obs-b", "s1", vec(0, 1));
    const blob = JSON.parse(b.serialize()) as { entries: Array<[string, { id: string }]> };
    // obs-b's id must be later than obs-a's burned id 1.
    expect(BigInt(blob.entries[0]![1].id) > 1n).toBe(true);
  });
});

describe("fallback logic", () => {
  it("createTurbovecBackend returns null when no native module is available", async () => {
    expect(await createTurbovecBackend(DIMS, 4, { nativeModule: null })).toBeNull();
  });

  it("createTurbovecBackend returns null when the module rejects the config", async () => {
    // dims not a multiple of 8 — the native constructor throws.
    expect(await createTurbovecBackend(DIMS + 1, 4, { nativeModule: mockModule() })).toBeNull();
  });

  it("makeConfiguredVectorIndex falls back to a TypeScript backend when turbovec can't load", async () => {
    process.env.MEMWARDEN_VECTOR_BACKEND = "turbovec";
    process.env.MEMWARDEN_QUANT_VECTOR = "true";
    // '@memwarden/turbovec' is not installed and <dataDir>/runtime is empty,
    // so the loader must fail and the TS quantized index must serve —
    // with a TypeScript label, never a native one.
    const idx = await makeConfiguredVectorIndex(384);
    expect(idx.backendLabel).toMatch(/^typescript\//);
  });

  it("makeConfiguredVectorIndex ignores turbovec entirely when backend=typescript", async () => {
    process.env.MEMWARDEN_VECTOR_BACKEND = "typescript";
    process.env.MEMWARDEN_QUANT_VECTOR = "true";
    const idx = await makeConfiguredVectorIndex(384);
    expect(idx.backendLabel).toBe("typescript/turboquant-4bit");
  });
});
