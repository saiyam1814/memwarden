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
});
