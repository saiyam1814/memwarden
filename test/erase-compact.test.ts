//
// Honest deletion, all the way down: chain-v2 oplog erasure + compaction.
//
// 1. PURE CHAIN: mixed v1/v2 chains verify; an erased v2 payload (null, with
//    payload_hash kept) verifies; a nulled v1 payload breaks the chain; a
//    tampered v2 payload is detected via payload_hash even though the entry
//    hash no longer covers the raw payload.
// 2. STORE ERASE (both stores, parity): new writes are v2; erasing a deleted
//    record's payloads keeps the chain intact and the entry hashes unchanged;
//    live records and v1 rows refuse; idempotent.
// 3. COMPACT (both stores, parity): live payloads byte-identical after,
//    forgotten payloads gone, chain verifies, the compact record anchors the
//    pre-compaction head hash; dry-run writes nothing; compact twice is safe;
//    writes after compact keep chaining.
// 4. LIBSQL FILE: a legacy v1 database migrates (columns added, mixed chain
//    verifies), erase refuses on v1 rows until compact re-chains, and the
//    deleted content is PROVABLY gone — a raw byte scan of the db file (and
//    -wal) finds no trace. Survives close/reopen.
// 5. END TO END: mem::forget {erase:true} / mem::erase produce receipts with
//    contentErased:true + chainHead, and the content is gone from the oplog.
// 6. SUPERSEDED-HISTORY PRUNING (--prune-history): outdated versions lose
//    their payload while keeping payload_hash, so the chain still verifies;
//    the newest version of every key, the recency window, and the erasure
//    guarantees are all untouched. Off by default.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreMemory } from "../src/state/store-memory.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import {
  COMPACT_KEY,
  COMPACT_SCOPE,
  ERASE_KEY,
  ERASE_SCOPE,
  GENESIS_PREV_HASH,
  NULL_PAYLOAD_HASH,
  hashOplogEntry,
  hashOplogEntryV2,
  hashPayload,
  pairKey,
  planCompaction,
  verifyChain,
} from "../src/state/oplog.js";
import {
  canonicalize,
  type OplogEntry,
  type OplogOp,
  type StateStore,
} from "../src/state/store.js";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  registerCoreFunctions,
  getSearchIndex,
} from "../src/functions/index.js";
import type { ForgetResult } from "../src/functions/receipt.js";

// --- pure chain helpers ----------------------------------------------------

/** Build a v1 entry (legacy hashing over the raw payload). */
function v1Entry(
  id: number,
  op: OplogOp,
  scope: string,
  key: string,
  payload: unknown,
  prev_hash: string,
): OplogEntry {
  const ts = `2026-01-0${(id % 9) + 1}T00:00:00.000Z`;
  const hash = hashOplogEntry({ id, ts, op, scope, key, payload, prev_hash });
  return { id, ts, op, scope, key, payload, v: 1, payload_hash: null, prev_hash, hash };
}

/** Build a v2 entry (hashing over payload_hash). */
function v2Entry(
  id: number,
  op: OplogOp,
  scope: string,
  key: string,
  payload: unknown,
  prev_hash: string,
): OplogEntry {
  const ts = `2026-01-0${(id % 9) + 1}T00:00:00.000Z`;
  const payload_hash = hashPayload(payload);
  const hash = hashOplogEntryV2({ id, ts, op, scope, key, payload_hash, prev_hash });
  return { id, ts, op, scope, key, payload, v: 2, payload_hash, prev_hash, hash };
}

describe("chain v2: pure verification", () => {
  it("a MIXED v1 + v2 chain verifies end to end", () => {
    const e1 = v1Entry(1, "set", "s", "a", { v: 1 }, GENESIS_PREV_HASH);
    const e2 = v1Entry(2, "delete", "s", "a", null, e1.hash);
    const e3 = v2Entry(3, "set", "s", "b", { v: 2 }, e2.hash);
    const e4 = v2Entry(4, "update", "s", "b", { v: 3 }, e3.hash);
    expect(verifyChain([e1, e2, e3, e4])).toBeNull();
  });

  it("an UNAUTHORIZED null v2 payload BREAKS the chain (F4: silent nulling detected)", () => {
    // Pre-F4 this verified unconditionally: anyone with db access could null
    // any payload and the chain stayed green. Now a content-committed null
    // needs a later erase/compact record that authorizes it.
    const e1 = v2Entry(1, "set", "s", "a", { secret: "needle" }, GENESIS_PREV_HASH);
    const e2 = v2Entry(2, "delete", "s", "a", null, e1.hash);
    const erased: OplogEntry = { ...e1, payload: null }; // payload_hash intact
    expect(verifyChain([erased, e2])).toBe(1);
    // ... while a write-time null (delete: sentinel payload_hash) is fine.
    expect(verifyChain([e1, e2])).toBeNull();
  });

  it("an ERASED v2 entry verifies when a LATER erase record authorizes it (id + payload_hash)", () => {
    const e1 = v2Entry(1, "set", "s", "a", { secret: "needle" }, GENESIS_PREV_HASH);
    const e2 = v2Entry(2, "delete", "s", "a", null, e1.hash);
    const authorize = (erased: Array<{ id: number; payload_hash: string }>) =>
      v2Entry(3, "erase", ERASE_SCOPE, ERASE_KEY, { scope: "s", key: "a", erased }, e2.hash);

    const ok = authorize([{ id: 1, payload_hash: e1.payload_hash as string }]);
    expect(verifyChain([{ ...e1, payload: null }, e2, ok])).toBeNull();

    // an erase record naming a DIFFERENT id authorizes nothing
    const wrongId = authorize([{ id: 99, payload_hash: e1.payload_hash as string }]);
    expect(verifyChain([{ ...e1, payload: null }, e2, wrongId])).toBe(1);

    // a mismatched payload_hash in the erase list is rejected too
    const wrongHash = authorize([{ id: 1, payload_hash: NULL_PAYLOAD_HASH }]);
    expect(verifyChain([{ ...e1, payload: null }, e2, wrongHash])).toBe(1);
  });

  it("a compact record's erasedIds authorize nulls (the one-time migration re-anchor)", () => {
    const e1 = v2Entry(1, "set", "s", "a", { secret: "needle" }, GENESIS_PREV_HASH);
    const e2 = v2Entry(2, "delete", "s", "a", null, e1.hash);
    const rec = v2Entry(
      3,
      "compact",
      COMPACT_SCOPE,
      COMPACT_KEY,
      { previousHeadHash: e2.hash, entriesRewritten: 1, erasedCount: 1, erasedIds: [1], compactedAt: "2026-01-05T00:00:00.000Z" },
      e2.hash,
    );
    expect(verifyChain([{ ...e1, payload: null }, e2, rec])).toBeNull();
    // a LEGACY compact record without erasedIds does not authorize
    const legacyRec = v2Entry(
      3,
      "compact",
      COMPACT_SCOPE,
      COMPACT_KEY,
      { previousHeadHash: e2.hash, entriesRewritten: 1, erasedCount: 1, compactedAt: "2026-01-05T00:00:00.000Z" },
      e2.hash,
    );
    expect(verifyChain([{ ...e1, payload: null }, e2, legacyRec])).toBe(1);
  });

  it("nulling a v1 payload BREAKS the chain at that entry (why erase refuses v1)", () => {
    const e1 = v1Entry(1, "set", "s", "a", { secret: "x" }, GENESIS_PREV_HASH);
    const e2 = v1Entry(2, "delete", "s", "a", null, e1.hash);
    expect(verifyChain([{ ...e1, payload: null }, e2])).toBe(1);
  });

  it("a tampered v2 payload is DETECTED via payload_hash", () => {
    const e1 = v2Entry(1, "set", "s", "a", { v: 1 }, GENESIS_PREV_HASH);
    const e2 = v2Entry(2, "set", "s", "b", { v: 2 }, e1.hash);
    expect(verifyChain([{ ...e1, payload: { v: 1337 } }, e2])).toBe(1);
  });

  it("a v2 entry missing payload_hash is broken", () => {
    const e1 = v2Entry(1, "set", "s", "a", { v: 1 }, GENESIS_PREV_HASH);
    expect(verifyChain([{ ...e1, payload_hash: null }])).toBe(1);
  });

  it("null-payload sentinel is fixed and distinct from every real payload hash", () => {
    expect(hashPayload(null)).toBe(NULL_PAYLOAD_HASH);
    expect(hashPayload(undefined)).toBe(NULL_PAYLOAD_HASH);
    expect(hashPayload({ a: 1 })).not.toBe(NULL_PAYLOAD_HASH);
    // canonicalization: key order does not change the commitment
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });
});

// --- store-level erase + compact, both implementations (parity) -------------

type Factory = { name: string; make: () => StateStore };
const factories: Factory[] = [
  { name: "StoreMemory", make: () => new StoreMemory() },
  { name: "StoreLibsql", make: () => new StoreLibsql({ url: ":memory:" }) },
];

const SCOPE = "mem:obs:sessX";

for (const { name, make } of factories) {
  describe(`${name}: in-place oplog erasure`, () => {
    it("writes chain v2 entries with a correct payload_hash", async () => {
      const s = make();
      try {
        await s.set(SCOPE, "a", { secret: "needle-1" });
        await s.delete(SCOPE, "a");
        const log = await s.readOplog();
        expect(log.every((e) => e.v === 2)).toBe(true);
        expect(log[0]!.payload_hash).toBe(hashPayload({ secret: "needle-1" }));
        expect(log[1]!.payload_hash).toBe(NULL_PAYLOAD_HASH);
      } finally {
        await s.close();
      }
    });

    it("erases a deleted record's payloads; chain intact, entry hashes UNCHANGED", async () => {
      const s = make();
      try {
        await s.set(SCOPE, "a", { secret: "needle-2" });
        await s.update(SCOPE, "a", [{ type: "set", path: "more", value: "needle-2b" }]);
        await s.set(SCOPE, "keep", { live: "stays" });
        await s.delete(SCOPE, "a");
        const before = await s.readOplog();

        const r = await s.eraseOplogPayloads(SCOPE, "a");
        expect(r).toEqual({ erased: 2 }); // set + update payloads nulled

        const after = await s.readOplog();
        expect(await s.verifyOplog()).toEqual({ ok: true });
        // erased rows: payload gone, everything else byte-identical
        for (let i = 0; i < before.length; i++) {
          const b = before[i]!;
          const a = after[i]!;
          expect(a.hash).toBe(b.hash);
          expect(a.prev_hash).toBe(b.prev_hash);
          expect(a.payload_hash).toBe(b.payload_hash);
          if (b.key === "a" && b.op !== "delete") expect(a.payload).toBeNull();
          else expect(canonicalize(a.payload ?? null)).toBe(canonicalize(b.payload ?? null));
        }
        expect(JSON.stringify(after)).not.toContain("needle-2");
        // the live record's payload is untouched
        expect(await s.get(SCOPE, "keep")).toEqual({ live: "stays" });
      } finally {
        await s.close();
      }
    });

    it("REFUSES to erase a live record's history", async () => {
      const s = make();
      try {
        await s.set(SCOPE, "live", { secret: "alive" });
        const r = await s.eraseOplogPayloads(SCOPE, "live");
        expect(r).toEqual({ erased: 0, refused: "live-record" });
        const log = await s.readOplog();
        expect(log[0]!.payload).toEqual({ secret: "alive" });
      } finally {
        await s.close();
      }
    });

    it("is idempotent: a second erase touches nothing", async () => {
      const s = make();
      try {
        await s.set(SCOPE, "a", { x: 1 });
        await s.delete(SCOPE, "a");
        expect(await s.eraseOplogPayloads(SCOPE, "a")).toEqual({ erased: 1 });
        expect(await s.eraseOplogPayloads(SCOPE, "a")).toEqual({ erased: 0 });
        expect(await s.verifyOplog()).toEqual({ ok: true });
      } finally {
        await s.close();
      }
    });

    it("appends a chain-recorded erase entry authorizing exactly the nulled ids", async () => {
      const s = make();
      try {
        await s.set(SCOPE, "a", { secret: "auth-needle" });
        await s.set(SCOPE, "keep", { live: true });
        await s.delete(SCOPE, "a");
        const before = await s.readOplog();
        expect(await s.eraseOplogPayloads(SCOPE, "a")).toEqual({ erased: 1 });

        const log = await s.readOplog();
        expect(log.length).toBe(before.length + 1);
        const rec = log.at(-1)!;
        expect(rec.op).toBe("erase");
        expect(rec.scope).toBe(ERASE_SCOPE);
        expect(rec.key).toBe(ERASE_KEY);
        const p = rec.payload as {
          scope: string;
          key: string;
          erased: Array<{ id: number; payload_hash: string }>;
        };
        expect(p.scope).toBe(SCOPE);
        expect(p.key).toBe("a");
        expect(p.erased).toEqual([
          { id: before[0]!.id, payload_hash: before[0]!.payload_hash },
        ]);
        // the erase record never re-discloses content
        expect(JSON.stringify(rec)).not.toContain("auth-needle");
        expect(await s.verifyOplog()).toEqual({ ok: true });
        // a SECOND erase (nothing left to null) appends no record
        expect(await s.eraseOplogPayloads(SCOPE, "a")).toEqual({ erased: 0 });
        expect((await s.readOplog()).length).toBe(log.length);
      } finally {
        await s.close();
      }
    });

    it("erasing a never-existing key is a no-op success", async () => {
      const s = make();
      try {
        await s.set(SCOPE, "other", { x: 1 });
        expect(await s.eraseOplogPayloads(SCOPE, "ghost")).toEqual({ erased: 0 });
      } finally {
        await s.close();
      }
    });
  });

  describe(`${name}: compactOplog`, () => {
    async function seed(s: StateStore): Promise<void> {
      await s.set(SCOPE, "live1", { keep: "live-value-1" });
      await s.set(SCOPE, "dead1", { secret: "compact-needle-A" });
      await s.update(SCOPE, "dead1", [{ type: "set", path: "extra", value: "compact-needle-B" }]);
      await s.set("mem:sessions", "sessX", { observationCount: 2 });
      await s.delete(SCOPE, "dead1");
      await s.set(SCOPE, "live2", { keep: "live-value-2" });
      // reinsert-after-delete: the key is LIVE again; its earlier payloads
      // must NOT be erased (the pair is not delete-tailed).
      await s.set(SCOPE, "phoenix", { gen: 1, note: "phoenix-gen1" });
      await s.delete(SCOPE, "phoenix");
      await s.set(SCOPE, "phoenix", { gen: 2, note: "phoenix-gen2" });
    }

    it("erases forgotten payloads, keeps live ones byte-identical, chain verifies, head anchored", async () => {
      const s = make();
      try {
        await seed(s);
        const before = await s.readOplog();
        const oldHead = before[before.length - 1]!.hash;

        const r = await s.compactOplog();
        expect(r.dryRun).toBe(false);
        expect(r.erasedCount).toBe(2); // dead1 set + update
        expect(r.entriesRewritten).toBe(2); // all-v2 chain: only erased rows change
        expect(r.previousHeadHash).toBe(oldHead);

        const after = await s.readOplog();
        expect(await s.verifyOplog()).toEqual({ ok: true });
        expect(after.every((e) => e.v === 2)).toBe(true);

        // final entry is the compact record anchoring the old head hash
        const rec = after[after.length - 1]!;
        expect(rec.op).toBe("compact");
        expect(rec.scope).toBe(COMPACT_SCOPE);
        expect(rec.key).toBe(COMPACT_KEY);
        expect((rec.payload as { previousHeadHash: string }).previousHeadHash).toBe(oldHead);
        expect((rec.payload as { erasedCount: number }).erasedCount).toBe(2);

        // forgotten payloads gone; live + phoenix payloads byte-identical
        const bytes = JSON.stringify(after);
        expect(bytes).not.toContain("compact-needle");
        for (let i = 0; i < before.length; i++) {
          const b = before[i]!;
          const a = after[i]!;
          if (b.key === "dead1" && b.op !== "delete") {
            expect(a.payload).toBeNull();
            expect(a.payload_hash).toBe(b.payload_hash); // commitment survives
          } else {
            expect(canonicalize(a.payload ?? null)).toBe(canonicalize(b.payload ?? null));
          }
        }
        expect(bytes).toContain("phoenix-gen1"); // live again -> history kept
        expect(bytes).toContain("live-value-1");

        // live KV state untouched
        expect(await s.get(SCOPE, "live1")).toEqual({ keep: "live-value-1" });
        expect(await s.get(SCOPE, "phoenix")).toEqual({ gen: 2, note: "phoenix-gen2" });
        expect(await s.get(SCOPE, "dead1")).toBeNull();
      } finally {
        await s.close();
      }
    });

    it("dry-run reports counts and writes NOTHING", async () => {
      const s = make();
      try {
        await seed(s);
        const before = await s.readOplog();
        const r = await s.compactOplog({ dryRun: true });
        expect(r.dryRun).toBe(true);
        expect(r.erasedCount).toBe(2);
        expect(r.vacuum.ok).toBe(false);
        const after = await s.readOplog();
        expect(canonicalize(after)).toBe(canonicalize(before));
      } finally {
        await s.close();
      }
    });

    it("compact twice is safe: second run erases nothing new and re-anchors", async () => {
      const s = make();
      try {
        await seed(s);
        const r1 = await s.compactOplog();
        const head1 = (await s.readOplog()).at(-1)!.hash;
        const r2 = await s.compactOplog();
        expect(r2.erasedCount).toBe(0);
        expect(r2.previousHeadHash).toBe(head1);
        expect(await s.verifyOplog()).toEqual({ ok: true });
        const log = await s.readOplog();
        // two compact records, both preserved in order
        expect(log.filter((e) => e.op === "compact").length).toBe(2);
        expect(r1.previousHeadHash).not.toBe(r2.previousHeadHash);
      } finally {
        await s.close();
      }
    });

    it("writes after compact keep chaining onto the compact record", async () => {
      const s = make();
      try {
        await seed(s);
        await s.compactOplog();
        const rec = (await s.readOplog()).at(-1)!;
        await s.set(SCOPE, "post", { after: "compact" });
        const log = await s.readOplog();
        const post = log.at(-1)!;
        expect(post.prev_hash).toBe(rec.hash);
        expect(post.id).toBe(rec.id + 1);
        expect(await s.verifyOplog()).toEqual({ ok: true });
        // and the new record is erasable in place after its deletion
        await s.delete(SCOPE, "post");
        expect(await s.eraseOplogPayloads(SCOPE, "post")).toEqual({ erased: 1 });
        expect(await s.verifyOplog()).toEqual({ ok: true });
      } finally {
        await s.close();
      }
    });

    it("compacting an EMPTY log just writes the anchor record", async () => {
      const s = make();
      try {
        const r = await s.compactOplog();
        expect(r.entriesRewritten).toBe(0);
        expect(r.erasedCount).toBe(0);
        expect(r.previousHeadHash).toBe(GENESIS_PREV_HASH);
        const log = await s.readOplog();
        expect(log.length).toBe(1);
        expect(log[0]!.op).toBe("compact");
        expect(await s.verifyOplog()).toEqual({ ok: true });
      } finally {
        await s.close();
      }
    });
  });
}

describe("store parity: erase + compact behave identically", () => {
  it("identical scripts produce identical results and identical deterministic oplog fields", async () => {
    const mem = new StoreMemory();
    const sql = new StoreLibsql({ url: ":memory:" });
    try {
      for (const s of [mem, sql] as StateStore[]) {
        await s.set(SCOPE, "a", { secret: "p-needle" });
        await s.set(SCOPE, "b", { keep: true });
        await s.delete(SCOPE, "a");
      }
      // parity: refusals and successes byte-identical
      expect(await sql.eraseOplogPayloads(SCOPE, "b")).toEqual(
        await mem.eraseOplogPayloads(SCOPE, "b"),
      );
      expect(await sql.eraseOplogPayloads(SCOPE, "a")).toEqual(
        await mem.eraseOplogPayloads(SCOPE, "a"),
      );
      // parity: compact counts + anchored payload semantics
      const rMem = await mem.compactOplog();
      const rSql = await sql.compactOplog();
      expect(rSql.entriesRewritten).toBe(rMem.entriesRewritten);
      expect(rSql.erasedCount).toBe(rMem.erasedCount);
      // deterministic oplog projection identical (hashes differ only via ts)
      const project = (e: OplogEntry) => ({
        id: e.id,
        op: e.op,
        scope: e.scope,
        key: e.key,
        // The compact record's payload embeds ts-dependent hashes; mask it
        // (its deterministic counters were already compared above).
        payload: e.op === "compact" ? "(ts-dependent)" : (e.payload ?? null),
        v: e.v,
        // payload_hash is a pure function of the payload -> must match,
        // except on the compact record whose payload embeds timestamps.
        payload_hash: e.op === "compact" ? "(ts-dependent)" : e.payload_hash,
      });
      const memLog = (await mem.readOplog()).map(project);
      const sqlLog = (await sql.readOplog()).map(project);
      expect(canonicalize(sqlLog)).toBe(canonicalize(memLog));
      expect(await mem.verifyOplog()).toEqual({ ok: true });
      expect(await sql.verifyOplog()).toEqual({ ok: true });
    } finally {
      await mem.close();
      await sql.close();
    }
  });
});

// --- libSQL file db: legacy migration + provable byte-level erasure ---------

describe("StoreLibsql file db: legacy v1 migration and byte-level erasure", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memwarden-erase-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fileBytes(path: string): string {
    let all = "";
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(p)) all += readFileSync(p).toString("latin1");
    }
    return all;
  }

  /** Create a pre-v2 database: old schema, v1-hashed rows. */
  async function seedLegacyDb(path: string): Promise<{ headHash: string }> {
    const c = createClient({ url: `file:${path}` });
    await c.execute(
      `CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope, key))`,
    );
    await c.execute(
      `CREATE TABLE oplog (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
       op TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, payload TEXT,
       prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`,
    );
    const rows: Array<{ op: OplogOp; key: string; payload: unknown }> = [
      { op: "set", key: "keep", payload: { keep: "legacy-live" } },
      { op: "set", key: "gone", payload: { secret: "legacy-needle" } },
      { op: "delete", key: "gone", payload: null },
    ];
    let prev = GENESIS_PREV_HASH;
    let id = 0;
    for (const r of rows) {
      id++;
      const ts = new Date().toISOString();
      const hash = hashOplogEntry({
        id, ts, op: r.op, scope: SCOPE, key: r.key, payload: r.payload, prev_hash: prev,
      });
      await c.execute({
        sql: `INSERT INTO oplog (id, ts, op, scope, key, payload, prev_hash, hash)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, ts, r.op, SCOPE, r.key,
          r.payload === null ? null : JSON.stringify(r.payload), prev, hash],
      });
      prev = hash;
    }
    const now = new Date().toISOString();
    await c.execute({
      sql: `INSERT INTO kv (scope, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: [SCOPE, "keep", JSON.stringify({ keep: "legacy-live" }), now, now],
    });
    c.close();
    return { headHash: prev };
  }

  it("opens a legacy db, verifies the v1 chain, and appends v2 (mixed chain verifies)", async () => {
    const path = join(dir, "legacy.db");
    await seedLegacyDb(path);
    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      expect(await s.verifyOplog()).toEqual({ ok: true });
      const legacy = await s.readOplog();
      expect(legacy.every((e) => e.v === 1 && e.payload_hash === null)).toBe(true);
      await s.set(SCOPE, "fresh", { new: true });
      const log = await s.readOplog();
      expect(log.at(-1)!.v).toBe(2);
      expect(await s.verifyOplog()).toEqual({ ok: true }); // mixed v1 + v2
    } finally {
      await s.close();
    }
  });

  it("erase refuses on v1 rows (pointer to compact); compact migrates, erases, VACUUMs — bytes provably gone", async () => {
    const path = join(dir, "legacy.db");
    const { headHash } = await seedLegacyDb(path);
    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      // v1 rows block in-place erasure — all-or-none, chain never broken
      const refused = await s.eraseOplogPayloads(SCOPE, "gone");
      expect(refused).toEqual({ erased: 0, refused: "v1-entries", v1Count: 1 });
      expect(fileBytes(path)).toContain("legacy-needle");

      // compact: migrate everything to v2, erase the forgotten payload
      const r = await s.compactOplog();
      expect(r.erasedCount).toBe(1);
      expect(r.previousHeadHash).toBe(headHash);
      expect(r.vacuum.ok).toBe(true);
      expect(await s.verifyOplog()).toEqual({ ok: true });
      const log = await s.readOplog();
      expect(log.every((e) => e.v === 2)).toBe(true);

      // the content is GONE from the file itself, not just the rows
      const bytes = fileBytes(path);
      expect(bytes).not.toContain("legacy-needle");
      // ... while live data survives byte-identically
      expect(await s.get(SCOPE, "keep")).toEqual({ keep: "legacy-live" });
      expect(bytes).toContain("legacy-live");
    } finally {
      await s.close();
    }
  });

  it("in-place erase on a v2 file db removes the content bytes from disk", async () => {
    const path = join(dir, "fresh.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      await s.set(SCOPE, "a", { secret: "erase-me-bytes" });
      await s.set(SCOPE, "keep", { keep: "stay-bytes" });
      await s.delete(SCOPE, "a");
      expect(fileBytes(path)).toContain("erase-me-bytes");

      expect(await s.eraseOplogPayloads(SCOPE, "a")).toEqual({ erased: 1 });
      expect(await s.verifyOplog()).toEqual({ ok: true });
      // secure_delete + WAL truncate: no trace in db, -wal, or -shm
      const bytes = fileBytes(path);
      expect(bytes).not.toContain("erase-me-bytes");
      expect(bytes).toContain("stay-bytes");
    } finally {
      await s.close();
    }
  });

  it("an attacker nulling a payload with raw SQL is DETECTED (unauthorized erasure fails verification)", async () => {
    const path = join(dir, "tamper.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    await s.set(SCOPE, "victim", { secret: "silently-nulled" });
    await s.delete(SCOPE, "victim"); // even a deleted pair: nulling without the store is unauthorized
    expect(await s.verifyOplog()).toEqual({ ok: true });
    await s.close();

    const c = createClient({ url: `file:${path}` });
    await c.execute({
      sql: `UPDATE oplog SET payload = NULL WHERE scope = ? AND key = ? AND payload IS NOT NULL`,
      args: [SCOPE, "victim"],
    });
    c.close();

    const s2 = new StoreLibsql({ url: `file:${path}` });
    try {
      const v = await s2.verifyOplog();
      expect(v.ok).toBe(false);
      // a subsequent compact re-anchors the chain (erasedIds authorize the null)
      await s2.compactOplog();
      expect(await s2.verifyOplog()).toEqual({ ok: true });
    } finally {
      await s2.close();
    }
  });

  it("compacted db survives close/reopen with an intact chain", async () => {
    const path = join(dir, "reopen.db");
    const s1 = new StoreLibsql({ url: `file:${path}` });
    await s1.set(SCOPE, "a", { secret: "bye" });
    await s1.delete(SCOPE, "a");
    await s1.set(SCOPE, "b", { keep: 1 });
    await s1.compactOplog();
    await s1.close();

    const s2 = new StoreLibsql({ url: `file:${path}` });
    try {
      expect(await s2.verifyOplog()).toEqual({ ok: true });
      expect(await s2.get(SCOPE, "b")).toEqual({ keep: 1 });
      const log = await s2.readOplog();
      expect(log.at(-1)!.op).toBe("compact");
      await s2.set(SCOPE, "c", { more: true });
      expect(await s2.verifyOplog()).toEqual({ ok: true });
    } finally {
      await s2.close();
    }
  });
});

// --- end to end: forget --erase / mem::erase receipts ------------------------

describe("mem::forget {erase} + mem::erase + /memwarden/compact end to end", () => {
  let sdk: Kernel;
  let kv: StateKV;
  let store: StoreMemory;

  beforeEach(() => {
    __resetKernelSingleton();
    getSearchIndex().clear();
    store = new StoreMemory();
    sdk = registerWorker("in-process", { workerName: "memwarden-erase" }, { store });
    kv = new StateKV(sdk);
    registerCoreFunctions(sdk, kv);
  });

  afterEach(() => {
    __resetKernelSingleton();
  });

  async function observe(narrative: string): Promise<string> {
    const result = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "sess-E",
        project: "proj-E",
        cwd: "/work/proj-E",
        timestamp: new Date().toISOString(),
        data: { tool_name: "Bash", tool_input: { command: "x" }, tool_output: narrative },
      },
    });
    return result.observationId;
  }

  it("forget with erase:true returns contentErased:true and the content is gone from the oplog", async () => {
    const needle = "zanzibar-rotation-cadence-veryunique";
    const obsId = await observe(`the deploy uses ${needle} tokens`);
    expect(JSON.stringify(await store.readOplog())).toContain(needle);

    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::forget",
      payload: { observationId: obsId, erase: true },
    });
    expect(r.deleted).toBe(true);
    expect(r.eraseBlocked).toBeUndefined();
    const rec = r.receipt!;
    expect(rec.contentErased).toBe(true);
    expect(rec.eraseIncomplete).toBeNull();
    expect(rec.chainIntact).toBe(true);
    expect(rec.chainHead).not.toBeNull();
    expect(rec.deleteEntry).not.toBeNull();

    // the receipt's chainHead is the real head of the real chain
    const log = await store.readOplog();
    expect(rec.chainHead!.hash).toBe(log.at(-1)!.hash);
    // content erased from every oplog payload; chain still verifies
    expect(JSON.stringify(log)).not.toContain(needle);
    expect(await store.verifyOplog()).toEqual({ ok: true });
    // receipts never re-disclose content
    expect(JSON.stringify(rec)).not.toContain(needle);
  });

  it("plain forget still reports contentErased:false and keeps the pointer honest", async () => {
    const obsId = await observe("plain forget leaves oplog payload behind");
    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::forget",
      payload: { observationId: obsId },
    });
    expect(r.receipt!.contentErased).toBe(false);
    expect(r.receipt!.chainHead).not.toBeNull();
  });

  it("mem::erase is forget + erase with one receipt", async () => {
    const obsId = await observe("erase function id direct path");
    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: obsId },
    });
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(true);
    const gone = await kv.get(KV.observations("sess-E"), obsId);
    expect(gone).toBeNull();
  });

  it("erase CASCADES into derived records: firstPrompt, summary, handoff — active store AND oplog history (F3)", async () => {
    const canary = "quetzal-rotation-cadence-canary";
    const base = { sessionId: "sess-C", project: "proj-C", cwd: "/work/proj-C" };
    const p = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: "2026-07-11T10:00:00.000Z",
        data: { prompt: `rotate the deploy key using ${canary} today` },
      },
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        ...base,
        timestamp: "2026-07-11T10:05:00.000Z",
        data: { tool_name: "Edit", tool_input: { file_path: "src/deploy.ts" }, tool_output: "ok" },
      },
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "session_end",
        ...base,
        timestamp: "2026-07-11T11:00:00.000Z",
        data: { reason: "exit" },
      },
    });

    // Sanity: the canary reached every derived record (the F3 leak).
    const before = await kv.get<{ firstPrompt?: string; summary?: string }>(KV.sessions, "sess-C");
    expect(before?.firstPrompt).toContain(canary);
    expect(before?.summary).toContain(canary);
    expect(JSON.stringify(await kv.get(KV.summaries, "sess-C"))).toContain(canary);

    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(true);

    // The canary is GONE: active store, derived records, the whole oplog,
    // and the receipt itself.
    const everything =
      JSON.stringify(await kv.list(KV.sessions)) +
      JSON.stringify(await kv.list(KV.observations("sess-C"))) +
      JSON.stringify(await kv.list(KV.summaries)) +
      JSON.stringify(await store.readOplog()) +
      JSON.stringify(r);
    expect(everything).not.toContain(canary);

    // …and the derived records were RE-DERIVED (as if the observation never
    // existed), not destroyed.
    const after = await kv.get<{
      status?: string;
      summary?: string;
      firstPrompt?: string;
      observationCount?: number;
    }>(KV.sessions, "sess-C");
    expect(after?.status).toBe("completed");
    expect(after?.summary).toContain("Goal: (no prompt captured)");
    expect(after?.firstPrompt).toBeUndefined();
    expect(after?.observationCount).toBe(2); // edit + handoff remain
    const summary = await kv.get<{ narrative: string; filesModified: string[] }>(
      KV.summaries,
      "sess-C",
    );
    expect(summary?.filesModified).toContain("src/deploy.ts");
    // The chain still verifies (every cascade erasure is authorized).
    expect(await store.verifyOplog()).toEqual({ ok: true });
  });

  it("erase cascades into Déjà Fix capsules derived from the observation (F3)", async () => {
    const canary = "zorble-guard-fix-canary";
    const obsId = await observe(
      `TypeError: deploy is not a function. Fixed by adding the ${canary} check.`,
    );
    const lookup = () =>
      sdk.trigger<unknown, { fixes: unknown[] }>({
        function_id: "mem::dejafix_lookup",
        payload: { error_text: "TypeError: deploy is not a function", cwd: "/work/proj-E" },
      });
    expect((await lookup()).fixes.length).toBe(1);

    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: obsId },
    });
    expect(r.deleted).toBe(true);

    expect((await lookup()).fixes.length).toBe(0);
    const everything =
      JSON.stringify(await kv.list("mem:dejafix")) +
      JSON.stringify(await store.readOplog());
    expect(everything).not.toContain(canary);
    expect(await store.verifyOplog()).toEqual({ ok: true });
  });

  it("erase is ATOMIC: a cascade failure deletes NOTHING and the forget is retryable", async () => {
    const canary = "atomic-abort-retry-canary";
    const base = { sessionId: "sess-A", project: "proj-A", cwd: "/work/proj-A" };
    const p = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: "2026-07-13T10:00:00.000Z",
        data: { prompt: `rotate the key with ${canary}` },
      },
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "session_end",
        ...base,
        timestamp: "2026-07-13T11:00:00.000Z",
        data: { reason: "exit" },
      },
    });

    // Fault injection: the cascade's first store write fails.
    const origDelete = kv.delete.bind(kv);
    (kv as { delete: typeof kv.delete }).delete = async () => {
      throw new Error("injected store failure");
    };
    const failed = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
    (kv as { delete: typeof kv.delete }).delete = origDelete;

    expect(failed.deleted).toBe(false);
    expect(failed.reason).toMatch(/source memory was NOT deleted/);
    expect(failed.reason).toMatch(/partially re-derived/);
    expect(failed.reason).toMatch(/[Rr]etry/);
    // The source observation is UNTOUCHED — no half-erased state.
    expect(await kv.get(KV.observations("sess-A"), p.observationId)).not.toBeNull();

    // Retry succeeds end to end — the exact flow the old order made
    // impossible ("no observation with id" after a failed cascade).
    const retried = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
    expect(retried.deleted).toBe(true);
    expect(retried.receipt!.contentErased).toBe(true);
    expect(retried.receipt!.eraseIncomplete).toBeNull();
    const everything =
      JSON.stringify(await kv.list(KV.sessions)) +
      JSON.stringify(await kv.list(KV.observations("sess-A"))) +
      JSON.stringify(await kv.list(KV.summaries)) +
      JSON.stringify(await store.readOplog());
    expect(everything).not.toContain(canary);
  });

  it("receipt admits RESIDUALS: content surviving in a sibling observation flips contentErased false", async () => {
    const canary = "the walrus rotation cadence is forty two minutes";
    const base = { sessionId: "sess-R", project: "proj-R", cwd: "/work/proj-R" };
    const p = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: "2026-07-13T10:00:00.000Z",
        data: { prompt: `remember that ${canary}` },
      },
    });
    // An INDEPENDENT sibling observation echoes the same content.
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        ...base,
        timestamp: "2026-07-13T10:05:00.000Z",
        data: {
          tool_name: "Bash",
          tool_input: { command: "cat notes.txt" },
          tool_output: `notes say: ${canary}`,
        },
      },
    });

    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
    expect(r.deleted).toBe(true);
    // The sibling is its own memory — NOT silently deleted — so the receipt
    // must not claim the content is gone.
    expect(r.receipt!.contentErased).toBe(false);
    expect(r.receipt!.eraseIncomplete).toMatch(/still appears in/);
    expect(r.receipt!.eraseIncomplete).toMatch(/obs_/);
  });

  it("outcome containment: an Outcome echoing the erased content is dropped, not re-injected", async () => {
    const canary = "the deploy key lives in the vault under badger";
    const base = { sessionId: "sess-OC", project: "proj-OC", cwd: "/work/proj-OC" };
    const p = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: "2026-07-13T10:00:00.000Z",
        data: { prompt: `note: ${canary}` },
      },
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "session_end",
        ...base,
        timestamp: "2026-07-13T11:00:00.000Z",
        data: {
          reason: "exit",
          // The assistant ECHOED the content being erased.
          assistant_response: `Noted — ${canary}, saved for later.`,
        },
      },
    });
    expect(
      (await kv.get<{ summary?: string }>(KV.sessions, "sess-OC"))?.summary,
    ).toContain("badger");

    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
    expect(r.deleted).toBe(true);
    // The rebuilt summary must not carry the echo back in via Outcome.
    const after = await kv.get<{ summary?: string }>(KV.sessions, "sess-OC");
    expect(after?.summary ?? "").not.toContain("badger");
    expect(r.receipt!.contentErased).toBe(true);
    expect(r.receipt!.eraseIncomplete).toBeNull();
  });

  it("partial cascade failure at a LATER write is reported honestly and retry CONVERGES", async () => {
    const canary = "pelican failover threshold is nine seconds exactly";
    const base = { sessionId: "sess-P", project: "proj-P", cwd: "/work/proj-P" };
    const p = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: "2026-07-13T10:00:00.000Z",
        data: { prompt: `remember ${canary}` },
      },
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "session_end",
        ...base,
        timestamp: "2026-07-13T11:00:00.000Z",
        data: { reason: "exit" },
      },
    });

    // Fail the SECOND store delete (the summaries rewrite) — the handoff
    // rewrite has already been applied by then.
    const origDelete = kv.delete.bind(kv);
    let deletes = 0;
    (kv as { delete: typeof kv.delete }).delete = async (scope: string, key: string) => {
      deletes++;
      if (deletes === 2) throw new Error("injected late failure");
      return origDelete(scope, key);
    };
    const failed = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
    (kv as { delete: typeof kv.delete }).delete = origDelete;

    expect(failed.deleted).toBe(false);
    // Honest: source intact, derived records possibly partially re-derived.
    expect(failed.reason).toMatch(/source memory was NOT deleted/);
    expect(failed.reason).toMatch(/partially re-derived/);
    expect(await kv.get(KV.observations("sess-P"), p.observationId)).not.toBeNull();

    // Retry converges to the fully erased state.
    const retried = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
    expect(retried.deleted).toBe(true);
    expect(retried.receipt!.contentErased).toBe(true);
    const everything =
      JSON.stringify(await kv.list(KV.sessions)) +
      JSON.stringify(await kv.list(KV.observations("sess-P"))) +
      JSON.stringify(await kv.list(KV.summaries)) +
      JSON.stringify(await store.readOplog());
    expect(everything).not.toContain("pelican");
  });

  it("cascade rebuild PRESERVES the handoff's Outcome line", async () => {
    const base = { sessionId: "sess-O", project: "proj-O", cwd: "/work/proj-O" };
    const p = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: "2026-07-13T10:00:00.000Z",
        data: { prompt: "fix the flaky deploy test" },
      },
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "session_end",
        ...base,
        timestamp: "2026-07-13T11:00:00.000Z",
        data: {
          reason: "exit",
          assistant_response: "Shipped the fix; deploy test green on CI.",
        },
      },
    });
    const before = await kv.get<{ summary?: string }>(KV.sessions, "sess-O");
    expect(before?.summary).toContain("Outcome: Shipped the fix");

    // Erase the prompt — the rebuilt handoff must not lose the outcome.
    await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
    const after = await kv.get<{ summary?: string }>(KV.sessions, "sess-O");
    expect(after?.summary).toContain("Outcome: Shipped the fix");
    expect(after?.summary).not.toContain("flaky deploy test");
  });

  it("erasing the HANDOFF observation itself scrubs Session.summary and the stored summary (F3)", async () => {
    const base = { sessionId: "sess-H", project: "proj-H", cwd: "/work/proj-H" };
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: "2026-07-11T10:00:00.000Z",
        data: { prompt: "wire the flag" },
      },
    });
    const end = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "session_end",
        ...base,
        timestamp: "2026-07-11T11:00:00.000Z",
        data: { reason: "exit" },
      },
    });

    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: end.observationId },
    });
    expect(r.deleted).toBe(true);

    const session = await kv.get<{ summary?: string; firstPrompt?: string }>(
      KV.sessions,
      "sess-H",
    );
    expect(session?.summary).toBeUndefined();
    expect(await kv.get(KV.summaries, "sess-H")).toBeNull();
    // The prompt observation itself is untouched (only the handoff was erased).
    expect(session?.firstPrompt).toContain("wire the flag");
    // No oplog payload for the erased handoff remains.
    const handoffRows = (await store.readOplog()).filter((e) => e.key === end.observationId);
    expect(handoffRows.every((e) => e.payload === null)).toBe(true);
    expect(await store.verifyOplog()).toEqual({ ok: true });
  });

  it("an erase receipt redacts the title (never re-discloses erased content)", async () => {
    const canary = "title-canary-phrase";
    const base = { sessionId: "sess-T", project: "proj-T", cwd: "/work/proj-T" };
    const p = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: new Date().toISOString(),
        data: { prompt: `${canary} is the whole prompt` },
      },
    });
    const r = await sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
    expect(r.receipt!.title).toBe("(erased)");
    expect(JSON.stringify(r)).not.toContain(canary);
  });

  it("HTTP: forget passes erase through; compact route works incl. dry_run", async () => {
    const { registerApiTriggers } = await import("../src/triggers/api.js");
    registerApiTriggers(sdk, kv);
    const obsId = await observe("http-level erase works end to end");

    const ok = await sdk.invokeHttp("api::forget", {
      headers: {},
      query_params: {},
      body: { observation_id: obsId, erase: true },
    });
    expect(ok.status_code).toBe(200);
    expect((ok.body as ForgetResult).receipt?.contentErased).toBe(true);

    const dry = await sdk.invokeHttp("api::compact", {
      headers: {},
      query_params: {},
      body: { dry_run: true },
    });
    expect(dry.status_code).toBe(200);
    expect((dry.body as { dryRun: boolean }).dryRun).toBe(true);

    const real = await sdk.invokeHttp("api::compact", {
      headers: {},
      query_params: {},
      body: {},
    });
    expect(real.status_code).toBe(200);
    const rb = real.body as { dryRun: boolean; previousHeadHash: string };
    expect(rb.dryRun).toBe(false);
    expect(rb.previousHeadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.verifyOplog()).toEqual({ ok: true });
  });
});

describe("residual detection catches SHORT secrets (the PIN 7391 class)", () => {
  let sdk: Kernel;
  let kv: StateKV;
  let store: StoreMemory;
  beforeEach(() => {
    __resetKernelSingleton();
    getSearchIndex().clear();
    store = new StoreMemory();
    sdk = registerWorker("in-process", { workerName: "memwarden-pin" }, { store });
    kv = new StateKV(sdk);
    registerCoreFunctions(sdk, kv);
  });
  afterEach(() => {
    __resetKernelSingleton();
  });

  async function eraseWithSibling(prompt: string, siblingOutput: string) {
    const base = { sessionId: "sess-PIN", project: "proj-PIN", cwd: "/w/pin" };
    const p = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: "2026-07-13T10:00:00.000Z",
        data: { prompt },
      },
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        ...base,
        timestamp: "2026-07-13T10:05:00.000Z",
        data: {
          tool_name: "Bash",
          tool_input: { command: "cat door.txt" },
          tool_output: siblingOutput,
        },
      },
    });
    return sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
  }

  it("a short whole-value secret surviving in a sibling flips contentErased false", async () => {
    const r = await eraseWithSibling("PIN 7391", "door says PIN 7391");
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(false);
    expect(r.receipt!.eraseIncomplete).toMatch(/still appears in/);
  });

  it("a digit-bearing token from a longer erased text is caught on its own", async () => {
    const r = await eraseWithSibling(
      "remember that the door code is PIN 7391 for the office",
      "code: 7391",
    );
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(false);
    expect(r.receipt!.eraseIncomplete).toMatch(/still appears in/);
  });

  it("year-shaped numbers do not false-positive", async () => {
    const r = await eraseWithSibling(
      "we decided this back in 2026 during the platform review",
      "meeting notes from 2026 about lunch",
    );
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(true);
  });

  it("a CASE/SPACING-variant echo of a compact value is still caught", async () => {
    // Compact value (< 5 words -> whole-value tier). Sibling echoes the FULL
    // phrase with different case/spacing. The whole tier must normalize or
    // this returns a false clean receipt (the reviewer's Finding 1).
    const r = await eraseWithSibling(
      "acmecorp prod cluster",
      "deploying to Acmecorp  Prod  Cluster today",
    );
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(false);
    expect(r.receipt!.residualScan).toBe("residuals");
  });

  it("a compact value with only a PARTIAL/absent echo still reports clean", async () => {
    // The sibling shares a word but not the full phrase — not a residual.
    const r = await eraseWithSibling(
      "acmecorp prod cluster",
      "deploying to the staging cluster today",
    );
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(true);
    expect(r.receipt!.residualScan).toBe("clean");
  });
});

describe("residual detection catches short ALPHABETIC values (the admin class)", () => {
  let sdk: Kernel;
  let kv: StateKV;
  beforeEach(() => {
    __resetKernelSingleton();
    getSearchIndex().clear();
    sdk = registerWorker("in-process", { workerName: "memwarden-admin" }, { store: new StoreMemory() });
    kv = new StateKV(sdk);
    registerCoreFunctions(sdk, kv);
  });
  afterEach(() => {
    __resetKernelSingleton();
  });

  async function eraseWithSibling(prompt: string, siblingOutput: string) {
    const base = { sessionId: "sess-ADM", project: "proj-ADM", cwd: "/w/adm" };
    const p = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "user_prompt",
        ...base,
        timestamp: "2026-07-13T10:00:00.000Z",
        data: { prompt },
      },
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        ...base,
        timestamp: "2026-07-13T10:05:00.000Z",
        data: {
          tool_name: "Bash",
          tool_input: { command: "whoami" },
          tool_output: siblingOutput,
        },
      },
    });
    return sdk.trigger<unknown, ForgetResult>({
      function_id: "mem::erase",
      payload: { observationId: p.observationId },
    });
  }

  it('erasing "admin" while a sibling echoes it: contentErased false, residuals named', async () => {
    const r = await eraseWithSibling("admin", "current user: admin");
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(false);
    expect(r.receipt!.residualScan).toBe("residuals");
    expect(r.receipt!.eraseIncomplete).toMatch(/still appears in/);
  });

  it('erasing "admin" with clean siblings: conclusive clean scan, contentErased true', async () => {
    const r = await eraseWithSibling("admin", "current user: guest");
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(true);
    expect(r.receipt!.residualScan).toBe("clean");
  });

  it("a value below the scan floor (< 3 chars) refuses the headline claim as LIMITED", async () => {
    const r = await eraseWithSibling("42", "the answer is 42");
    expect(r.deleted).toBe(true);
    expect(r.receipt!.contentErased).toBe(false);
    expect(r.receipt!.residualScan).toBe("limited");
    expect(r.receipt!.eraseIncomplete).toMatch(/below the residual-detection floor/);
  });
});

// --- superseded-history pruning: the storage lever --------------------------
//
// A mature oplog is ~95% outdated versions of live keys (the same key written
// dozens of times, every historical payload retained forever). Pruning nulls
// those payloads and keeps payload_hash, so tamper-evidence — which lives in
// the hash CHAIN, not in the payload column — survives intact.

const PRUNE_SCOPE = "mem:obs:sessP";

/** Build a v2 chain with explicit ids/timestamps (window tests need both). */
function buildChain(
  specs: Array<{ op: OplogOp; key: string; payload: unknown; ts?: string; scope?: string }>,
): OplogEntry[] {
  const out: OplogEntry[] = [];
  let prev = GENESIS_PREV_HASH;
  specs.forEach((s, i) => {
    const id = i + 1;
    const ts = s.ts ?? `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;
    const scope = s.scope ?? PRUNE_SCOPE;
    const payload_hash = hashPayload(s.payload);
    const hash = hashOplogEntryV2({
      id, ts, op: s.op, scope, key: s.key, payload_hash, prev_hash: prev,
    });
    out.push({
      id, ts, op: s.op, scope, key: s.key, payload: s.payload,
      v: 2, payload_hash, prev_hash: prev, hash,
    });
    prev = hash;
  });
  return out;
}

const PRUNE = { pruneSuperseded: true } as const;

describe("planCompaction: superseded-history pruning", () => {
  it("nulls every superseded version, keeps the newest, chain verifies end to end", () => {
    const entries = buildChain([
      { op: "set", key: "a", payload: { gen: 1, note: "v1-needle" } },
      { op: "update", key: "a", payload: { gen: 2, note: "v2-needle" } },
      { op: "set", key: "a", payload: { gen: 3, note: "v3-keep" } },
    ]);
    const live = new Set([pairKey(PRUNE_SCOPE, "a")]);
    const plan = planCompaction(entries, live, "2026-02-01T00:00:00.000Z", PRUNE);

    expect(plan.prunedCount).toBe(2);
    expect(plan.erasedCount).toBe(0);
    expect(plan.entries[0]!.payload).toBeNull();
    expect(plan.entries[1]!.payload).toBeNull();
    expect(plan.entries[2]!.payload).toEqual({ gen: 3, note: "v3-keep" });
    // the whole rewritten chain (plus its anchor) verifies
    expect(verifyChain([...plan.entries, plan.compactRecord])).toBeNull();
    const bytes = JSON.stringify([...plan.entries, plan.compactRecord]);
    expect(bytes).not.toContain("v1-needle");
    expect(bytes).not.toContain("v2-needle");
    expect(bytes).toContain("v3-keep");
  });

  it("keeps the payload_hash of every pruned entry (the content commitment survives)", () => {
    const entries = buildChain([
      { op: "set", key: "a", payload: { gen: 1 } },
      { op: "set", key: "a", payload: { gen: 2 } },
    ]);
    const plan = planCompaction(
      entries,
      new Set([pairKey(PRUNE_SCOPE, "a")]),
      "2026-02-01T00:00:00.000Z",
      PRUNE,
    );
    expect(plan.entries[0]!.payload).toBeNull();
    expect(plan.entries[0]!.payload_hash).toBe(hashPayload({ gen: 1 }));
    expect(plan.entries[0]!.payload_hash).toBe(entries[0]!.payload_hash);
    expect(plan.entries[0]!.payload_hash).not.toBe(NULL_PAYLOAD_HASH);
    // ... and the compact record authorizes exactly that null
    const ids = (plan.compactRecord.payload as { erasedIds: number[] }).erasedIds;
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });

  it("is OFF by default: the 3-arg call plans exactly what it always did", () => {
    const entries = buildChain([
      { op: "set", key: "a", payload: { gen: 1 } },
      { op: "set", key: "a", payload: { gen: 2 } },
    ]);
    const live = new Set([pairKey(PRUNE_SCOPE, "a")]);
    const legacy = planCompaction(entries, live, "2026-02-01T00:00:00.000Z");
    const explicitOff = planCompaction(entries, live, "2026-02-01T00:00:00.000Z", {
      pruneSuperseded: false,
    });
    for (const plan of [legacy, explicitOff]) {
      expect(plan.prunedCount).toBe(0);
      expect(plan.entries[0]!.payload).toEqual({ gen: 1 });
      // nothing dropped: "after" is "before" plus the anchor record's payload
      const anchor = Buffer.byteLength(canonicalize(plan.compactRecord.payload), "utf8");
      expect(plan.payloadBytesAfter).toBe(plan.payloadBytesBefore + anchor);
    }
    expect(canonicalize(legacy.entries)).toBe(canonicalize(explicitOff.entries));
  });

  it("NEVER prunes the newest version of a live key, however old it is", () => {
    const entries = buildChain([
      { op: "set", key: "ancient", payload: { note: "written-once-in-2020" }, ts: "2020-01-01T00:00:00.000Z" },
      { op: "set", key: "other", payload: { n: 1 } },
      { op: "set", key: "other", payload: { n: 2 } },
    ]);
    const plan = planCompaction(
      entries,
      new Set([pairKey(PRUNE_SCOPE, "ancient"), pairKey(PRUNE_SCOPE, "other")]),
      "2026-02-01T00:00:00.000Z",
      PRUNE,
    );
    expect(plan.entries[0]!.payload).toEqual({ note: "written-once-in-2020" });
    expect(plan.prunedCount).toBe(1); // only other@n=1
  });

  it("keepPayloadsSince keeps the recency window in full", () => {
    const entries = buildChain([
      { op: "set", key: "a", payload: { gen: 1 }, ts: "2026-01-01T00:00:00.000Z" },
      { op: "set", key: "a", payload: { gen: 2 }, ts: "2026-01-10T00:00:00.000Z" },
      { op: "set", key: "a", payload: { gen: 3 }, ts: "2026-01-20T00:00:00.000Z" },
      { op: "set", key: "a", payload: { gen: 4 }, ts: "2026-01-30T00:00:00.000Z" },
    ]);
    const plan = planCompaction(
      entries,
      new Set([pairKey(PRUNE_SCOPE, "a")]),
      "2026-02-01T00:00:00.000Z",
      { pruneSuperseded: true, keepPayloadsSince: "2026-01-10T00:00:00.000Z" },
    );
    expect(plan.prunedCount).toBe(1); // only gen 1 is outside the window
    expect(plan.entries[0]!.payload).toBeNull();
    expect(plan.entries[1]!.payload).toEqual({ gen: 2 }); // ts === cutoff -> kept
    expect(plan.entries[2]!.payload).toEqual({ gen: 3 });
    expect(plan.entries[3]!.payload).toEqual({ gen: 4 });
    expect(verifyChain([...plan.entries, plan.compactRecord])).toBeNull();
  });

  it("a window covering everything prunes NOTHING", () => {
    const entries = buildChain([
      { op: "set", key: "a", payload: { gen: 1 } },
      { op: "set", key: "a", payload: { gen: 2 } },
    ]);
    const plan = planCompaction(
      entries,
      new Set([pairKey(PRUNE_SCOPE, "a")]),
      "2026-02-01T00:00:00.000Z",
      { pruneSuperseded: true, keepPayloadsSince: "2020-01-01T00:00:00.000Z" },
    );
    expect(plan.prunedCount).toBe(0);
    expect(plan.entries[0]!.payload).toEqual({ gen: 1 });
  });

  it("the recency window does NOT hold back ERASURE (a deletion is never deferred)", () => {
    const entries = buildChain([
      { op: "set", key: "gone", payload: { secret: "erase-needle" }, ts: "2026-01-30T00:00:00.000Z" },
      { op: "delete", key: "gone", payload: null, ts: "2026-01-30T00:00:01.000Z" },
    ]);
    const plan = planCompaction(entries, new Set(), "2026-02-01T00:00:00.000Z", {
      pruneSuperseded: true,
      keepPayloadsSince: "2026-01-01T00:00:00.000Z", // window covers both entries
    });
    expect(plan.erasedCount).toBe(1);
    expect(plan.prunedCount).toBe(0);
    expect(plan.entries[0]!.payload).toBeNull();
    expect(JSON.stringify(plan.entries)).not.toContain("erase-needle");
  });

  it("a delete-tailed pair keeps its ERASURE accounting when pruning is on", () => {
    const entries = buildChain([
      { op: "set", key: "dead", payload: { secret: "dead-1" } },
      { op: "update", key: "dead", payload: { secret: "dead-2" } },
      { op: "delete", key: "dead", payload: null },
      { op: "set", key: "live", payload: { n: 1 } },
      { op: "set", key: "live", payload: { n: 2 } },
    ]);
    const live = new Set([pairKey(PRUNE_SCOPE, "live")]);
    const off = planCompaction(entries, live, "2026-02-01T00:00:00.000Z");
    const on = planCompaction(entries, live, "2026-02-01T00:00:00.000Z", PRUNE);
    // erasedCount means the same thing with pruning on: a deleted record's
    // history, never double-counted as pruning.
    expect(off.erasedCount).toBe(2);
    expect(on.erasedCount).toBe(2);
    expect(on.prunedCount).toBe(1); // live@n=1 only
    expect(on.entries[4]!.payload).toEqual({ n: 2 });
    expect(JSON.stringify(on.entries)).not.toContain("dead-");
    expect(verifyChain([...on.entries, on.compactRecord])).toBeNull();
  });

  it("never prunes compact/erase anchor records (their payloads ARE the authorizations)", () => {
    const entries = buildChain([
      { op: "set", key: "a", payload: { gen: 1 } },
      { op: "set", key: "a", payload: { gen: 2 } },
      {
        op: "erase",
        key: ERASE_KEY,
        scope: ERASE_SCOPE,
        payload: { scope: PRUNE_SCOPE, key: "old", erased: [{ id: 1, payload_hash: "x" }] },
      },
      {
        op: "compact",
        key: COMPACT_KEY,
        scope: COMPACT_SCOPE,
        payload: {
          previousHeadHash: "", entriesRewritten: 0, erasedCount: 0, prunedCount: 0,
          erasedIds: [], compactedAt: "2026-01-05T00:00:00.000Z",
        },
      },
    ]);
    const plan = planCompaction(
      entries,
      new Set([pairKey(PRUNE_SCOPE, "a")]),
      "2026-02-01T00:00:00.000Z",
      PRUNE,
    );
    expect(plan.entries[2]!.payload).not.toBeNull();
    expect(plan.entries[3]!.payload).not.toBeNull();
    expect(plan.prunedCount).toBe(1);
  });

  it("is IDEMPOTENT: planning the pruned chain again changes nothing", () => {
    const entries = buildChain([
      { op: "set", key: "a", payload: { gen: 1 } },
      { op: "set", key: "a", payload: { gen: 2 } },
      { op: "set", key: "a", payload: { gen: 3 } },
    ]);
    const live = new Set([pairKey(PRUNE_SCOPE, "a")]);
    const first = planCompaction(entries, live, "2026-02-01T00:00:00.000Z", PRUNE);
    const chain1 = [...first.entries, first.compactRecord];
    const second = planCompaction(chain1, live, "2026-02-02T00:00:00.000Z", PRUNE);
    expect(second.prunedCount).toBe(0);
    expect(second.erasedCount).toBe(0);
    expect(second.entriesRewritten).toBe(0);
    expect(canonicalize(second.entries)).toBe(canonicalize(chain1));
    expect(verifyChain([...second.entries, second.compactRecord])).toBeNull();
  });

  it("reports honest payload bytes: before, after, and what the anchor record costs", () => {
    const filler = "x".repeat(500);
    const entries = buildChain([
      { op: "set", key: "a", payload: { gen: 1, filler } },
      { op: "set", key: "a", payload: { gen: 2, filler } },
      { op: "set", key: "a", payload: { gen: 3, filler } },
    ]);
    const plan = planCompaction(
      entries,
      new Set([pairKey(PRUNE_SCOPE, "a")]),
      "2026-02-01T00:00:00.000Z",
      PRUNE,
    );
    const one = Buffer.byteLength(canonicalize({ gen: 1, filler }), "utf8");
    expect(plan.payloadBytesBefore).toBe(3 * one);
    // one surviving payload + the compact record's own payload
    const anchor = Buffer.byteLength(canonicalize(plan.compactRecord.payload), "utf8");
    expect(plan.payloadBytesAfter).toBe(one + anchor);
    expect(plan.payloadBytesBefore - plan.payloadBytesAfter).toBeGreaterThan(2 * one - anchor - 1);
  });
});

for (const { name, make } of factories) {
  describe(`${name}: compactOplog --prune-history`, () => {
    /** Write `n` versions of `key`, each carrying a findable needle. */
    async function versions(s: StateStore, key: string, n: number): Promise<void> {
      for (let i = 1; i <= n; i++) {
        await s.set(PRUNE_SCOPE, key, { gen: i, note: `needle-${key}-${i}` });
      }
    }

    it("drops superseded payloads, keeps live values, chain verifies", async () => {
      const s = make();
      try {
        await versions(s, "a", 4);
        await versions(s, "b", 2);
        const before = await s.readOplog();

        const r = await s.compactOplog({ pruneSuperseded: true });
        expect(r.prunedCount).toBe(4); // a: 3 superseded, b: 1
        expect(r.erasedCount).toBe(0);
        expect(await s.verifyOplog()).toEqual({ ok: true });

        const after = await s.readOplog();
        const bytes = JSON.stringify(after);
        for (const gone of ["needle-a-1", "needle-a-2", "needle-a-3", "needle-b-1"]) {
          expect(bytes).not.toContain(gone);
        }
        expect(bytes).toContain("needle-a-4");
        expect(bytes).toContain("needle-b-2");
        // pruned rows keep their commitment; nothing else about them moved
        for (let i = 0; i < before.length; i++) {
          const b = before[i]!;
          const a = after[i]!;
          expect(a.id).toBe(b.id);
          expect(a.ts).toBe(b.ts);
          expect(a.payload_hash).toBe(b.payload_hash);
          expect(a.hash).toBe(b.hash);
        }
        // the live values themselves are untouched
        expect(await s.get(PRUNE_SCOPE, "a")).toEqual({ gen: 4, note: "needle-a-4" });
        expect(await s.get(PRUNE_SCOPE, "b")).toEqual({ gen: 2, note: "needle-b-2" });
      } finally {
        await s.close();
      }
    });

    it("prunes NOTHING without the flag (existing compactions unchanged)", async () => {
      const s = make();
      try {
        await versions(s, "a", 3);
        const r = await s.compactOplog();
        expect(r.prunedCount).toBe(0);
        expect(JSON.stringify(await s.readOplog())).toContain("needle-a-1");
        expect(await s.verifyOplog()).toEqual({ ok: true });
      } finally {
        await s.close();
      }
    });

    it("keepPayloadsSince spares fresh history", async () => {
      const s = make();
      try {
        await versions(s, "a", 3);
        // every entry was just written, so a one-hour window covers them all
        const r = await s.compactOplog({
          pruneSuperseded: true,
          keepPayloadsSince: new Date(Date.now() - 3_600_000).toISOString(),
        });
        expect(r.prunedCount).toBe(0);
        expect(JSON.stringify(await s.readOplog())).toContain("needle-a-1");
        expect(await s.verifyOplog()).toEqual({ ok: true });
      } finally {
        await s.close();
      }
    });

    it("is idempotent: a second pruning compaction prunes nothing new", async () => {
      const s = make();
      try {
        await versions(s, "a", 3);
        const r1 = await s.compactOplog({ pruneSuperseded: true });
        expect(r1.prunedCount).toBe(2);
        const log1 = await s.readOplog();

        const r2 = await s.compactOplog({ pruneSuperseded: true });
        expect(r2.prunedCount).toBe(0);
        expect(r2.erasedCount).toBe(0);
        expect(r2.entriesRewritten).toBe(0);
        expect(await s.verifyOplog()).toEqual({ ok: true });
        // only the new anchor record was appended
        const log2 = await s.readOplog();
        expect(log2.length).toBe(log1.length + 1);
        expect(canonicalize(log2.slice(0, log1.length))).toBe(canonicalize(log1));
      } finally {
        await s.close();
      }
    });

    it("still erases delete-tailed history, and forget --erase keeps working after", async () => {
      const s = make();
      try {
        await versions(s, "dead", 2);
        await s.delete(PRUNE_SCOPE, "dead");
        await versions(s, "live", 3);

        const r = await s.compactOplog({ pruneSuperseded: true });
        expect(r.erasedCount).toBe(2); // both versions of the deleted record
        expect(r.prunedCount).toBe(2); // live: 2 superseded
        expect(JSON.stringify(await s.readOplog())).not.toContain("needle-dead");
        expect(await s.verifyOplog()).toEqual({ ok: true });

        // in-place erasure still works on the pruned chain
        await s.delete(PRUNE_SCOPE, "live");
        const erase = await s.eraseOplogPayloads(PRUNE_SCOPE, "live");
        expect(erase.erased).toBe(1); // the one surviving payload
        expect(JSON.stringify(await s.readOplog())).not.toContain("needle-live");
        expect(await s.verifyOplog()).toEqual({ ok: true });
      } finally {
        await s.close();
      }
    });

    it("writes after a pruning compaction keep chaining", async () => {
      const s = make();
      try {
        await versions(s, "a", 3);
        await s.compactOplog({ pruneSuperseded: true });
        const rec = (await s.readOplog()).at(-1)!;
        await s.set(PRUNE_SCOPE, "a", { gen: 4, note: "needle-a-4" });
        const log = await s.readOplog();
        expect(log.at(-1)!.prev_hash).toBe(rec.hash);
        expect(await s.verifyOplog()).toEqual({ ok: true });
      } finally {
        await s.close();
      }
    });

    it("measured shrink: 40 versions of one key collapse to one payload", async () => {
      const s = make();
      try {
        const filler = "y".repeat(1000);
        for (let i = 1; i <= 40; i++) {
          await s.set(PRUNE_SCOPE, "big", { gen: i, filler });
        }
        const payloadBytes = async (): Promise<number> =>
          (await s.readOplog()).reduce(
            (n, e) =>
              n +
              (e.payload === null || e.payload === undefined
                ? 0
                : Buffer.byteLength(canonicalize(e.payload), "utf8")),
            0,
          );
        const measuredBefore = await payloadBytes();

        const r = await s.compactOplog({ pruneSuperseded: true });
        const measuredAfter = await payloadBytes();
        const one = Buffer.byteLength(canonicalize({ gen: 40, filler }), "utf8");

        expect(r.prunedCount).toBe(39);
        expect(r.payloadBytesBefore).toBe(measuredBefore);
        expect(r.payloadBytesAfter).toBe(measuredAfter);
        // 39 of 40 payloads gone: the surviving cost is one payload plus the
        // anchor record (which lists the 39 authorized nulls).
        expect(measuredBefore).toBeGreaterThan(39 * 1000);
        expect(measuredAfter).toBeLessThan(one + 2000);
        expect(measuredBefore - measuredAfter).toBeGreaterThan(38 * 1000);
        expect(await s.verifyOplog()).toEqual({ ok: true });
        expect(await s.get(PRUNE_SCOPE, "big")).toEqual({ gen: 40, filler });
      } finally {
        await s.close();
      }
    });
  });
}

describe("store parity: pruning plans identically in both stores", () => {
  it("same script -> same counts, same bytes, same deterministic oplog fields", async () => {
    const mem = new StoreMemory();
    const sql = new StoreLibsql({ url: ":memory:" });
    try {
      for (const s of [mem, sql] as StateStore[]) {
        for (let i = 1; i <= 3; i++) await s.set(PRUNE_SCOPE, "a", { gen: i });
        for (let i = 1; i <= 2; i++) await s.set(PRUNE_SCOPE, "dead", { gen: i });
        await s.delete(PRUNE_SCOPE, "dead");
        await s.set("mem:sessions", "sessP", { observationCount: 3 });
      }
      const rMem = await mem.compactOplog({ pruneSuperseded: true });
      const rSql = await sql.compactOplog({ pruneSuperseded: true });
      expect(rSql.prunedCount).toBe(rMem.prunedCount);
      expect(rSql.erasedCount).toBe(rMem.erasedCount);
      expect(rSql.entriesRewritten).toBe(rMem.entriesRewritten);
      expect(rSql.payloadBytesBefore).toBe(rMem.payloadBytesBefore);
      expect(rSql.payloadBytesAfter).toBe(rMem.payloadBytesAfter);
      expect(rMem.prunedCount).toBe(2);
      expect(rMem.erasedCount).toBe(2);

      // Deterministic projection (hashes embed ts, so mask the anchor record).
      const project = (e: OplogEntry) => ({
        id: e.id,
        op: e.op,
        scope: e.scope,
        key: e.key,
        payload: e.op === "compact" ? "(ts-dependent)" : (e.payload ?? null),
        v: e.v,
        payload_hash: e.op === "compact" ? "(ts-dependent)" : e.payload_hash,
      });
      expect(canonicalize((await sql.readOplog()).map(project))).toBe(
        canonicalize((await mem.readOplog()).map(project)),
      );
      expect(await mem.verifyOplog()).toEqual({ ok: true });
      expect(await sql.verifyOplog()).toEqual({ ok: true });
    } finally {
      await mem.close();
      await sql.close();
    }
  });
});

describe("StoreLibsql file db: pruned versions leave the file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memwarden-prune-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("superseded bytes are provably gone from the db file; the newest value stays", async () => {
    const path = join(dir, "prune.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      for (let i = 1; i <= 6; i++) {
        await s.set(PRUNE_SCOPE, "k", { gen: i, note: `prune-needle-${i}` });
      }
      const raw = (): string => {
        let all = "";
        for (const p of [path, `${path}-wal`, `${path}-shm`]) {
          if (existsSync(p)) all += readFileSync(p).toString("latin1");
        }
        return all;
      };
      expect(raw()).toContain("prune-needle-1");

      const r = await s.compactOplog({ pruneSuperseded: true });
      expect(r.prunedCount).toBe(5);
      expect(r.vacuum.ok).toBe(true);
      expect(await s.verifyOplog()).toEqual({ ok: true });

      const bytes = raw();
      for (let i = 1; i <= 5; i++) expect(bytes).not.toContain(`prune-needle-${i}`);
      expect(bytes).toContain("prune-needle-6");
      expect(await s.get(PRUNE_SCOPE, "k")).toEqual({ gen: 6, note: "prune-needle-6" });
    } finally {
      await s.close();
    }
  });

  it("survives close/reopen with an intact chain", async () => {
    const path = join(dir, "reopen-prune.db");
    const s1 = new StoreLibsql({ url: `file:${path}` });
    for (let i = 1; i <= 4; i++) await s1.set(PRUNE_SCOPE, "k", { gen: i });
    await s1.compactOplog({ pruneSuperseded: true });
    await s1.close();

    const s2 = new StoreLibsql({ url: `file:${path}` });
    try {
      expect(await s2.verifyOplog()).toEqual({ ok: true });
      expect(await s2.get(PRUNE_SCOPE, "k")).toEqual({ gen: 4 });
      await s2.set(PRUNE_SCOPE, "k", { gen: 5 });
      expect(await s2.verifyOplog()).toEqual({ ok: true });
    } finally {
      await s2.close();
    }
  });
});

describe("POST /memwarden/compact: prune_history + keep_days", () => {
  let sdk: Kernel;
  let kv: StateKV;
  let store: StoreMemory;

  beforeEach(async () => {
    __resetKernelSingleton();
    getSearchIndex().clear();
    store = new StoreMemory();
    sdk = registerWorker("in-process", { workerName: "memwarden-prune" }, { store });
    kv = new StateKV(sdk);
    registerCoreFunctions(sdk, kv);
    const { registerApiTriggers } = await import("../src/triggers/api.js");
    registerApiTriggers(sdk, kv);
  });
  afterEach(() => {
    __resetKernelSingleton();
  });

  const post = (body: unknown) =>
    sdk.invokeHttp("api::compact", { headers: {}, query_params: {}, body });
  // The window boundary is inclusive (ts >= cutoff is kept), and a test writes
  // its whole fixture inside one millisecond — so step off the boundary before
  // asking for keep_days: 0.
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

  it("prune_history prunes superseded versions; the default 7d window spares fresh ones", async () => {
    for (let i = 1; i <= 3; i++) await store.set(PRUNE_SCOPE, "a", { gen: i });

    // Everything was just written, so the default 7-day window covers it all.
    const fresh = await post({ prune_history: true });
    expect(fresh.status_code).toBe(200);
    expect((fresh.body as { prunedCount: number }).prunedCount).toBe(0);

    // keep_days: 0 means "keep no window" -> superseded versions go.
    await tick();
    const r = await post({ prune_history: true, keep_days: 0 });
    expect(r.status_code).toBe(200);
    const b = r.body as { prunedCount: number; payloadBytesBefore: number; payloadBytesAfter: number };
    expect(b.prunedCount).toBe(2);
    const log = JSON.stringify(await store.readOplog());
    expect(log).not.toContain('"gen":1');
    expect(log).toContain('"gen":3');
    expect(await store.verifyOplog()).toEqual({ ok: true });
    // Honest accounting, even when it is unflattering: on a toy log the two
    // pruned payloads are smaller than the anchor record compaction appends,
    // so "after" can legitimately exceed "before".
    expect(b.payloadBytesBefore).toBeGreaterThan(0);
    expect(b.payloadBytesAfter).toBeGreaterThan(0);
  });

  it("without prune_history nothing is pruned (and dry_run still writes nothing)", async () => {
    for (let i = 1; i <= 3; i++) await store.set(PRUNE_SCOPE, "a", { gen: i });
    const before = await store.readOplog();
    await tick();
    const dry = await post({ dry_run: true, prune_history: true, keep_days: 0 });
    expect((dry.body as { dryRun: boolean; prunedCount: number }).prunedCount).toBe(2);
    expect(canonicalize(await store.readOplog())).toBe(canonicalize(before));

    const plain = await post({});
    expect((plain.body as { prunedCount: number }).prunedCount).toBe(0);
    expect(JSON.stringify(await store.readOplog())).toContain('"gen":1');
  });

  it("a bad keep_days is REFUSED, not silently defaulted", async () => {
    for (const bad of [-1, "7", Number.NaN, null]) {
      const r = await post({ prune_history: true, keep_days: bad });
      expect(r.status_code).toBe(400);
      expect((r.body as { error: string }).error).toMatch(/keep_days/);
    }
    // nothing was written by any of the refusals
    expect((await store.readOplog()).length).toBe(0);
  });
});
