//
// Native turbovec vector backend (optional). Wraps the '@memwarden/turbovec'
// napi binding (native/turbovec-node) behind the VectorBackend contract.
// memwarden's core keeps ZERO native dependencies: the module is resolved at
// runtime via dynamic import — first the bare specifier (a real install),
// then <dataDir>/runtime/node_modules (the side-loaded runtime location, the
// same convention the optional embedding runtime uses). When neither
// resolves, the caller (search.ts makeConfiguredVectorIndex) logs honestly
// and falls back to the TypeScript backend — the label always tells the
// truth about which engine is serving.
//
// The native index speaks u64 ids; memwarden speaks string obsIds. This
// file owns that mapping: a monotonic bigint counter allocates native ids,
// and both the mapping and the counter are persisted inside the serialize()
// blob (stored alongside everything else in the KV store by
// vector-persistence.ts) so ids stay stable across restarts. Native ids are
// never reused within a blob lineage — remove() burns the id.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { VectorBackend, VectorBackendHit } from "./vector-backend.js";
import { getDataDir } from "./config.js";
import { logger } from "./logger.js";

export const TURBOVEC_BLOB_VERSION = 1;

// --- native module surface (mirrors native/turbovec-node/index.d.ts) ------

export interface NativeSearchHits {
  ids: BigUint64Array;
  scores: Float32Array;
}

export interface NativeTurbovecIndex {
  addWithIds(vectors: Float32Array, ids: BigUint64Array): void;
  remove(id: bigint): boolean;
  contains(id: bigint): boolean;
  search(query: Float32Array, k: number, allowlist?: BigUint64Array): NativeSearchHits;
  save(path: string): void;
  readonly len: number;
  readonly dims: number;
  readonly bitWidth: number;
}

export interface NativeTurbovecModule {
  TurbovecIndex: {
    new (dims: number, bitWidth: number): NativeTurbovecIndex;
    load(path: string): NativeTurbovecIndex;
  };
}

// --- loader ----------------------------------------------------------------

function isNativeModule(mod: unknown): mod is NativeTurbovecModule {
  return (
    typeof mod === "object" &&
    mod !== null &&
    typeof (mod as { TurbovecIndex?: unknown }).TurbovecIndex === "function"
  );
}

/**
 * Resolve the native module, or null. Tries, in order:
 *   1. the bare specifier '@memwarden/turbovec' (installed dependency),
 *   2. <dataDir>/runtime/node_modules/@memwarden/turbovec (side-loaded
 *      runtime install, so `npx memwarden` users can add the native backend
 *      without touching the package itself).
 * Never throws — a load failure is an expected, supported state.
 */
export async function loadNativeTurbovec(): Promise<NativeTurbovecModule | null> {
  const specifiers = [
    "@memwarden/turbovec",
    pathToFileURL(
      join(getDataDir(), "runtime", "node_modules", "@memwarden", "turbovec", "index.js"),
    ).href,
  ];
  for (const specifier of specifiers) {
    try {
      const mod: unknown = await import(specifier);
      if (isNativeModule(mod)) return mod;
      // CJS interop: the binding's index.js is CommonJS; some loaders only
      // expose it under `default`.
      const dflt = (mod as { default?: unknown })?.default;
      if (isNativeModule(dflt)) return dflt;
    } catch {
      continue;
    }
  }
  return null;
}

// --- persistence blob shape --------------------------------------------

interface TurbovecBlob {
  backend: "turbovec";
  version: number;
  dims: number;
  bits: number;
  /** Monotonic native-id counter (bigint as decimal string). */
  counter: string;
  /** [obsId, { id: nativeId as decimal string, s: sessionId }] */
  entries: Array<[string, { id: string; s: string }]>;
  /** The native .tvim index file, base64. */
  tvim: string;
}

interface MappedEntry {
  id: bigint;
  sessionId: string;
}

// --- backend ---------------------------------------------------------------

export class TurbovecBackend implements VectorBackend {
  readonly dims: number;
  readonly bits: number;
  private readonly mod: NativeTurbovecModule;
  private native: NativeTurbovecIndex;
  private byObsId = new Map<string, MappedEntry>();
  private byNativeId = new Map<bigint, string>();
  // Monotonic; persisted with the blob. Starts at 1 (0 is reserved as an
  // obviously-invalid id for debugging). clear() does NOT reset it, so a
  // clear+rebuild in one process can never collide with stale native state.
  private counter = 1n;

  constructor(mod: NativeTurbovecModule, dims: number, bits: number) {
    this.mod = mod;
    this.dims = dims;
    this.bits = bits;
    this.native = new mod.TurbovecIndex(dims, bits);
  }

  /** See VectorBackend.backendLabel. Only ever reported when the native
   * module actually loaded — the fallback path constructs a TS backend. */
  get backendLabel(): string {
    return `turbovec/native-${this.bits}bit`;
  }

  add(obsId: string, sessionId: string, embedding: Float32Array): void {
    if (embedding.length !== this.dims) return; // soft-skip, guarded upstream
    const previous = this.byObsId.get(obsId);
    // The native index rejects duplicate ids, so a re-add replaces:
    // remove the old vector first, then insert under a fresh native id.
    if (previous) {
      this.native.remove(previous.id);
      this.byNativeId.delete(previous.id);
      this.byObsId.delete(obsId);
    }
    const id = this.counter++;
    try {
      this.native.addWithIds(embedding, new BigUint64Array([id]));
    } catch (err) {
      // e.g. non-finite coordinates. The add is atomic on the native side;
      // the maps were not touched yet, so state stays consistent (minus the
      // replaced previous entry, which is intentionally gone).
      logger.warn("turbovec add failed — vector skipped", {
        obsId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.byObsId.set(obsId, { id, sessionId });
    this.byNativeId.set(id, obsId);
  }

  remove(obsId: string): void {
    const entry = this.byObsId.get(obsId);
    if (!entry) return;
    this.native.remove(entry.id);
    this.byObsId.delete(obsId);
    this.byNativeId.delete(entry.id);
  }

  has(obsId: string): boolean {
    return this.byObsId.has(obsId);
  }

  ids(): string[] {
    return [...this.byObsId.keys()];
  }

  get size(): number {
    return this.byObsId.size;
  }

  search(query: Float32Array, limit = 20): VectorBackendHit[] {
    if (query.length !== this.dims || this.byObsId.size === 0 || limit < 1) {
      return [];
    }
    const hits = this.native.search(query, limit);
    const out: VectorBackendHit[] = [];
    for (let i = 0; i < hits.ids.length; i++) {
      const nativeId = hits.ids[i] as bigint;
      const obsId = this.byNativeId.get(nativeId);
      if (obsId === undefined) continue; // never surface an unmapped id
      const entry = this.byObsId.get(obsId);
      if (!entry) continue;
      out.push({
        obsId,
        sessionId: entry.sessionId,
        score: hits.scores[i] as number,
      });
    }
    return out;
  }

  /**
   * Allowlist-restricted search: only the given obsIds may be returned.
   * The obsId allowlist is translated to the native u64 allowlist, so the
   * restriction runs inside the native scan. Wired by mem::search when a
   * project/cwd scope is active (and exercised by the benchmark gate).
   * Unknown obsIds are ignored; an effectively empty allowlist returns [].
   */
  searchAllowed(
    query: Float32Array,
    limit: number,
    allowedObsIds: ReadonlySet<string> | readonly string[],
  ): VectorBackendHit[] {
    if (query.length !== this.dims || this.byObsId.size === 0 || limit < 1) {
      return [];
    }
    const allowed: bigint[] = [];
    for (const obsId of allowedObsIds) {
      const entry = this.byObsId.get(obsId);
      if (entry) allowed.push(entry.id);
    }
    if (allowed.length === 0) return [];
    const hits = this.native.search(query, limit, BigUint64Array.from(allowed));
    const out: VectorBackendHit[] = [];
    for (let i = 0; i < hits.ids.length; i++) {
      const obsId = this.byNativeId.get(hits.ids[i] as bigint);
      if (obsId === undefined) continue;
      const entry = this.byObsId.get(obsId);
      if (!entry) continue;
      out.push({ obsId, sessionId: entry.sessionId, score: hits.scores[i] as number });
    }
    return out;
  }

  validateDimensions(expected: number): {
    mismatches: Array<{ obsId: string; dim: number }>;
    seenDimensions: Set<number>;
  } {
    // Same contract as QuantizedVectorIndex: dims are fixed at construction,
    // so either everything matches or everything mismatches.
    const mismatches: Array<{ obsId: string; dim: number }> = [];
    const seenDimensions = new Set<number>();
    if (this.byObsId.size > 0) {
      seenDimensions.add(this.dims);
      if (this.dims !== expected) {
        for (const obsId of this.byObsId.keys()) {
          mismatches.push({ obsId, dim: this.dims });
        }
      }
    }
    return { mismatches, seenDimensions };
  }

  clear(): void {
    this.native = new this.mod.TurbovecIndex(this.dims, this.bits);
    this.byObsId.clear();
    this.byNativeId.clear();
    // counter intentionally NOT reset — see field comment.
  }

  /** Directory for the on-disk .tvim artifacts (the native save/load format). */
  private tvimDir(): string {
    return join(getDataDir(), "turbovec");
  }

  serialize(): string {
    const dir = this.tvimDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "index.tvim");
    this.native.save(path);
    const tvim = readFileSync(path).toString("base64");
    const entries: TurbovecBlob["entries"] = [];
    for (const [obsId, entry] of this.byObsId) {
      entries.push([obsId, { id: entry.id.toString(), s: entry.sessionId }]);
    }
    const blob: TurbovecBlob = {
      backend: "turbovec",
      version: TURBOVEC_BLOB_VERSION,
      dims: this.dims,
      bits: this.bits,
      counter: this.counter.toString(),
      entries,
      tvim,
    };
    return JSON.stringify(blob);
  }

  /**
   * In-place restore from a serialize() blob. Returns true only when the
   * blob parses, its params match this backend, the native .tvim loads
   * through turbovec's validated loader, AND the id tables agree exactly
   * with the native index (same count, every mapped id present). Any
   * failure leaves the backend EMPTY and consistent and returns false —
   * the caller treats that as "rebuild from the source of truth".
   */
  restoreFromBlob(json: string): boolean {
    let blob: TurbovecBlob;
    try {
      blob = JSON.parse(json) as TurbovecBlob;
    } catch {
      return false;
    }
    if (
      blob?.backend !== "turbovec" ||
      blob.version !== TURBOVEC_BLOB_VERSION ||
      blob.dims !== this.dims ||
      blob.bits !== this.bits ||
      typeof blob.tvim !== "string" ||
      typeof blob.counter !== "string" ||
      !Array.isArray(blob.entries)
    ) {
      return false;
    }
    try {
      const dir = this.tvimDir();
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "index.tvim");
      writeFileSync(path, Buffer.from(blob.tvim, "base64"));
      const native = this.mod.TurbovecIndex.load(path);
      const byObsId = new Map<string, MappedEntry>();
      const byNativeId = new Map<bigint, string>();
      let maxId = 0n;
      for (const row of blob.entries) {
        if (!Array.isArray(row) || row.length < 2) return false;
        const [obsId, entry] = row;
        if (
          typeof obsId !== "string" ||
          typeof entry?.id !== "string" ||
          typeof entry?.s !== "string"
        ) {
          return false;
        }
        const id = BigInt(entry.id);
        // The mapping must agree with the native index and be bijective.
        if (byObsId.has(obsId) || byNativeId.has(id) || !native.contains(id)) {
          return false;
        }
        byObsId.set(obsId, { id, sessionId: entry.s });
        byNativeId.set(id, obsId);
        if (id > maxId) maxId = id;
      }
      if (native.len !== byObsId.size) return false; // native ids without a mapping
      let counter: bigint;
      try {
        counter = BigInt(blob.counter);
      } catch {
        return false;
      }
      if (counter <= maxId) counter = maxId + 1n; // never re-issue a live id
      this.native = native;
      this.byObsId = byObsId;
      this.byNativeId = byNativeId;
      this.counter = counter;
      return true;
    } catch (err) {
      logger.warn("turbovec restore failed — will rebuild", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

/**
 * Construct a TurbovecBackend for the given dims, or null when the native
 * module cannot be loaded or refuses the configuration (e.g. dims not a
 * multiple of 8). Logs the concrete reason — the caller decides the
 * fallback, this function never pretends.
 */
export async function createTurbovecBackend(
  dims: number,
  bits: number,
  opts?: { nativeModule?: NativeTurbovecModule | null },
): Promise<TurbovecBackend | null> {
  const mod =
    opts && "nativeModule" in opts ? opts.nativeModule : await loadNativeTurbovec();
  if (!mod) {
    logger.warn(
      "turbovec backend requested but '@memwarden/turbovec' is not installed " +
        "(tried the bare specifier and <dataDir>/runtime/node_modules) — " +
        "falling back to the TypeScript backend",
    );
    return null;
  }
  try {
    return new TurbovecBackend(mod, dims, bits);
  } catch (err) {
    logger.warn("turbovec backend construction failed — falling back to the TypeScript backend", {
      dims,
      bits,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
