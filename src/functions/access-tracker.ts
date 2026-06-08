//
// Access-frequency tracking for retention scoring. search.ts and context.ts
// call recordAccessBatch fire-and-forget after assembling results, so later
// retention/decay can weight memories by how recently they were used. Each
// per-memory write is serialized through the keyed mutex, and every failure is
// swallowed: access tracking must never break a read.

import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { logger } from "./logger.js";

const RECENT_CAP = 20;

export interface AccessLog {
  memoryId: string;
  count: number;
  lastAt: string;
  recent: number[];
}

export function emptyAccessLog(memoryId: string): AccessLog {
  return { memoryId, count: 0, lastAt: "", recent: [] };
}

export function normalizeAccessLog(raw: unknown): AccessLog {
  const r = (raw ?? {}) as Partial<AccessLog>;
  const count =
    typeof r.count === "number" && Number.isFinite(r.count)
      ? Math.max(0, Math.floor(r.count))
      : 0;
  const recentAll = Array.isArray(r.recent)
    ? r.recent.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    : [];
  const recent = recentAll.slice(-RECENT_CAP);
  return {
    memoryId: typeof r.memoryId === "string" ? r.memoryId : "",
    // count can never be below the number of timestamps we actually hold
    count: Math.max(count, recent.length),
    lastAt: typeof r.lastAt === "string" ? r.lastAt : "",
    recent,
  };
}

export async function getAccessLog(
  kv: StateKV,
  memoryId: string,
): Promise<AccessLog> {
  try {
    const raw = await kv.get<AccessLog>(KV.accessLog, memoryId);
    if (!raw) return emptyAccessLog(memoryId);
    const log = normalizeAccessLog(raw);
    if (!log.memoryId) log.memoryId = memoryId;
    return log;
  } catch {
    return emptyAccessLog(memoryId);
  }
}

function keyFor(memoryId: string): string {
  return `mem:access:${memoryId}`;
}

export async function recordAccess(
  kv: StateKV,
  memoryId: string,
  timestampMs?: number,
): Promise<void> {
  if (!memoryId) return;
  const ts = timestampMs ?? Date.now();
  try {
    await withKeyedLock(keyFor(memoryId), async () => {
      const log = await getAccessLog(kv, memoryId);
      log.count += 1;
      log.lastAt = new Date(ts).toISOString();
      log.recent.push(ts);
      if (log.recent.length > RECENT_CAP) {
        log.recent = log.recent.slice(-RECENT_CAP);
      }
      await kv.set(KV.accessLog, memoryId, log);
    });
  } catch (err) {
    try {
      logger.warn("recordAccess failed", {
        memoryId,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // the side path must never throw
    }
  }
}

export async function recordAccessBatch(
  kv: StateKV,
  memoryIds: string[],
  timestampMs?: number,
): Promise<void> {
  if (!memoryIds || memoryIds.length === 0) return;
  const ts = timestampMs ?? Date.now();
  const ids = [...new Set(memoryIds.filter(Boolean))];
  await Promise.allSettled(ids.map((id) => recordAccess(kv, id, ts)));
}

export async function deleteAccessLog(
  kv: StateKV,
  memoryId: string,
): Promise<void> {
  if (!memoryId) return;
  try {
    await withKeyedLock(keyFor(memoryId), () => kv.delete(KV.accessLog, memoryId));
  } catch {
    // best-effort, idempotent
  }
}
