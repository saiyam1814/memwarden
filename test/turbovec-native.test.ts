//
// Integration tests against the REAL @memwarden/turbovec binding built from
// native/turbovec-node. These SKIP (loudly, with build instructions) when
// the platform .node binary hasn't been built — the unit coverage for the
// mapping/fallback logic lives in turbovec-backend.test.ts and always runs.
//
// Build the binding with:
//   cd native/turbovec-node && npm install && npm run build

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TurbovecBackend,
  type NativeTurbovecModule,
} from "../src/functions/turbovec-backend.js";
import { mulberry32, seedFromString } from "../src/functions/turboquant.js";

const require = createRequire(import.meta.url);
const BINDING_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "native",
  "turbovec-node",
  "index.js",
);

// Availability probe: require the generated loader and construct once.
// createRequire bypasses vite transforms, so the .node load path is the
// same one production uses.
let native: NativeTurbovecModule | null = null;
try {
  const mod = require(BINDING_PATH) as NativeTurbovecModule;
  // eslint-disable-next-line no-new
  new mod.TurbovecIndex(8, 4);
  native = mod;
} catch {
  native = null;
}

const DIMS = 384;
const N = 300;

/** Deterministic normalized pseudo-embeddings (same PRNG as the TS index). */
function makeVectors(count: number, seed: string): Float32Array[] {
  const rand = mulberry32(seedFromString(seed));
  const out: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    const v = new Float32Array(DIMS);
    let norm = 0;
    for (let d = 0; d < DIMS; d++) {
      // Box-Muller-ish gaussian for realistic geometry.
      const x = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
      v[d] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIMS; d++) v[d] = (v[d] as number) / norm;
    out.push(v);
  }
  return out;
}

describe.skipIf(native === null)(
  "turbovec native binding (SKIPPED: .node binary not built — run `cd native/turbovec-node && npm install && npm run build`)",
  () => {
    let dataDir: string;
    let savedDataDir: string | undefined;
    let backend: TurbovecBackend;
    const vectors = makeVectors(N, "memwarden-native-test");

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), "memwarden-tvnative-"));
      savedDataDir = process.env.MEMWARDEN_DATA_DIR;
      process.env.MEMWARDEN_DATA_DIR = dataDir;
      backend = new TurbovecBackend(native!, DIMS, 4);
      for (let i = 0; i < N; i++) {
        backend.add(`obs-${i}`, `session-${i % 7}`, vectors[i]!);
      }
    });

    afterEach(() => {
      if (savedDataDir === undefined) delete process.env.MEMWARDEN_DATA_DIR;
      else process.env.MEMWARDEN_DATA_DIR = savedDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("add/search round-trip: an exact stored vector is its own top hit", () => {
      expect(backend.size).toBe(N);
      expect(backend.backendLabel).toBe("turbovec/native-4bit");
      for (const probe of [0, 17, 123, N - 1]) {
        const hits = backend.search(vectors[probe]!, 5);
        expect(hits.length).toBe(5);
        expect(hits[0]!.obsId).toBe(`obs-${probe}`);
        expect(hits[0]!.sessionId).toBe(`session-${probe % 7}`);
        // ordered by score
        for (let i = 1; i < hits.length; i++) {
          expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
        }
      }
    });

    it("remove: removed ids never come back; re-adding works", () => {
      backend.remove("obs-42");
      expect(backend.has("obs-42")).toBe(false);
      const hits = backend.search(vectors[42]!, 20);
      expect(hits.map((h) => h.obsId)).not.toContain("obs-42");
      backend.add("obs-42", "session-x", vectors[42]!);
      expect(backend.search(vectors[42]!, 1)[0]).toMatchObject({
        obsId: "obs-42",
        sessionId: "session-x",
      });
    });

    it("allowlist filtering never returns a non-allowed id", () => {
      const rand = mulberry32(seedFromString("allowlist"));
      for (let trial = 0; trial < 10; trial++) {
        const allowed = new Set<string>();
        for (let i = 0; i < N; i++) if (rand() < 0.1) allowed.add(`obs-${i}`);
        allowed.add("obs-ghost-not-in-index");
        const q = vectors[Math.floor(rand() * N)]!;
        const hits = backend.searchAllowed(q, 25, [...allowed]);
        expect(hits.length).toBeGreaterThan(0);
        for (const h of hits) expect(allowed.has(h.obsId)).toBe(true);
        expect(hits.map((h) => h.obsId)).not.toContain("obs-ghost-not-in-index");
      }
      expect(backend.searchAllowed(vectors[0]!, 10, ["obs-ghost-not-in-index"])).toEqual([]);
    });

    it("persist round-trip through the .tvim validated loader keeps the searchable id set", () => {
      backend.remove("obs-7");
      backend.remove("obs-8");
      const before = backend.search(vectors[3]!, 10).map((h) => h.obsId);
      const blob = backend.serialize();

      const restored = new TurbovecBackend(native!, DIMS, 4);
      expect(restored.restoreFromBlob(blob)).toBe(true);
      expect(restored.size).toBe(N - 2);
      expect(new Set(restored.ids())).toEqual(new Set(backend.ids()));
      expect(restored.search(vectors[3]!, 10).map((h) => h.obsId)).toEqual(before);

      // adds after restore keep working (fresh, non-colliding native ids)
      restored.add("obs-new", "s", vectors[7]!);
      expect(restored.search(vectors[7]!, 1)[0]!.obsId).toBe("obs-new");
    });

    it("rejects a blob whose id table was tampered with", () => {
      const blob = JSON.parse(backend.serialize()) as {
        entries: Array<[string, { id: string; s: string }]>;
      };
      blob.entries[0]![1].id = String(10_000_000);
      const restored = new TurbovecBackend(native!, DIMS, 4);
      expect(restored.restoreFromBlob(JSON.stringify(blob))).toBe(false);
      expect(restored.size).toBe(0);
    });
  },
);
