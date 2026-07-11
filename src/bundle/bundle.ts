//
// Brain Bundle — portable export/import of a memwarden store. Lets a user
// move their memory between machines, or seed a fresh instance, without a
// vendor in the loop. The bundle is plain JSON of the durable state:
// sessions, memories, per-session observations, and (if present) the
// TurboQuant index blob so vectors survive the move without re-embedding.
//
// Pure functions over a StateKV; the caller stamps the timestamp and does
// the file/HTTP I/O. Ed25519 signing and encryption layer on top later
// without changing this shape.

import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { DEJAFIX_SCOPE } from "../functions/dejafix.js";
import type {
  CompressedObservation,
  Memory,
  Session,
} from "../functions/types.js";

export const BRAIN_BUNDLE_KIND = "memwarden.brain";
export const BRAIN_BUNDLE_VERSION = 1;
const QUANT_BLOB_KEY = "index-blob"; // mirrors vector-persistence.ts

export interface BrainBundle {
  kind: typeof BRAIN_BUNDLE_KIND;
  version: number;
  exportedAt?: string;
  sessions: Session[];
  memories: Memory[];
  observations: Record<string, CompressedObservation[]>; // sessionId -> obs
  /** Déjà Fix capsules (error signature -> fix), portable like the rest. */
  fixes?: Array<{ signature: string } & Record<string, unknown>>;
  quantBlob?: string;
}

export interface BundleCounts {
  sessions: number;
  memories: number;
  observations: number;
}

function countObservations(map: Record<string, CompressedObservation[]>): number {
  let n = 0;
  for (const k of Object.keys(map)) n += map[k]?.length ?? 0;
  return n;
}

/** Gather the durable store into a portable bundle. */
export async function exportBundle(kv: StateKV): Promise<BrainBundle> {
  const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
  const memories = await kv.list<Memory>(KV.memories).catch(() => []);
  const observations: Record<string, CompressedObservation[]> = {};
  for (const s of sessions) {
    observations[s.id] = await kv
      .list<CompressedObservation>(KV.observations(s.id))
      .catch(() => []);
  }
  const quantBlob = await kv
    .get<string>(KV.quantParams, QUANT_BLOB_KEY)
    .catch(() => null);
  const fixes = await kv
    .list<{ signature: string } & Record<string, unknown>>(DEJAFIX_SCOPE)
    .catch(() => []);

  const bundle: BrainBundle = {
    kind: BRAIN_BUNDLE_KIND,
    version: BRAIN_BUNDLE_VERSION,
    sessions,
    memories,
    observations,
  };
  if (typeof quantBlob === "string" && quantBlob.length > 0) {
    bundle.quantBlob = quantBlob;
  }
  if (fixes.length > 0) bundle.fixes = fixes;
  return bundle;
}

/** Validate a parsed object is a bundle we can import. */
export function isBrainBundle(value: unknown): value is BrainBundle {
  const b = value as Partial<BrainBundle> | null;
  return (
    !!b &&
    b.kind === BRAIN_BUNDLE_KIND &&
    typeof b.version === "number" &&
    Array.isArray(b.sessions) &&
    Array.isArray(b.memories) &&
    typeof b.observations === "object" &&
    b.observations !== null
  );
}

/**
 * Write a bundle into a (typically fresh) store. Existing keys are
 * overwritten (last-write-wins), matching the store's own semantics. The
 * search/vector indexes rebuild lazily on the next mem::search.
 */
export async function importBundle(
  kv: StateKV,
  bundle: BrainBundle,
): Promise<BundleCounts> {
  if (bundle.version !== BRAIN_BUNDLE_VERSION) {
    throw new Error(
      `unsupported brain bundle version ${bundle.version} (expected ${BRAIN_BUNDLE_VERSION})`,
    );
  }
  for (const s of bundle.sessions) {
    await kv.set(KV.sessions, s.id, s);
  }
  for (const m of bundle.memories) {
    await kv.set(KV.memories, m.id, m);
  }
  for (const sessionId of Object.keys(bundle.observations)) {
    for (const o of bundle.observations[sessionId] ?? []) {
      await kv.set(KV.observations(sessionId), o.id, o);
    }
  }
  for (const f of bundle.fixes ?? []) {
    if (f && typeof f.signature === "string" && f.signature) {
      await kv.set(DEJAFIX_SCOPE, f.signature, f);
    }
  }
  if (bundle.quantBlob) {
    await kv.set(KV.quantParams, QUANT_BLOB_KEY, bundle.quantBlob);
  }
  return {
    sessions: bundle.sessions.length,
    memories: bundle.memories.length,
    observations: countObservations(bundle.observations),
  };
}
