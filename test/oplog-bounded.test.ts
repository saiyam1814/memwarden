//
// Bounded-memory oplog access. A month of real use grew one brain's oplog to
// 459k entries / 1.35GB of payloads, and every caller that wanted a count,
// the head, receipt evidence, or a verification decoded ALL of it at once:
// `memwarden doctor` pushed the daemon to its 4GB heap limit and it crashed.
//
// 1. The payload-free accessors (oplogCount / oplogHead / findOplogEntries)
//    agree with a full read, in both stores.
// 2. The kernel builtins and the libSQL verify/compact paths never call the
//    load-everything readOplog().
// 3. Paged verification still catches tampering on a LATER page, and an
//    unauthorized null past the first page.
// 4. Streaming compaction across many pages plans exactly what the pure
//    planner plans (parity with StoreMemory), including a v1 -> v2 migration
//    of a legacy log larger than a page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreMemory } from "../src/state/store-memory.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { GENESIS_PREV_HASH, hashOplogEntry } from "../src/state/oplog.js";
import { OplogChainBrokenError, type OplogOp, type StateStore } from "../src/state/store.js";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";

// More than two OPLOG_PAGE (500) pages, so every paged loop crosses pages.
const WRITES = 1_300;
const KEYS = 40;
const SCOPE_A = "mem:obs:sessA";
const SCOPE_B = "mem:obs:sessB";

/** A deterministic write script: rewrites, cross-scope key reuse, deletes. */
async function script(s: StateStore): Promise<void> {
  for (let i = 0; i < WRITES; i++) {
    const key = `k${i % KEYS}`;
    const scope = i % 7 === 0 ? SCOPE_B : SCOPE_A;
    if (i % 5 === 0) {
      await s.update(scope, key, [{ type: "set", path: "gen", value: i }]);
    } else {
      await s.set(scope, key, { gen: i, body: `payload-${i}-${"x".repeat(i % 50)}` });
    }
  }
  // delete-tailed pairs: erasure candidates for compaction
  for (let k = 0; k < 6; k++) await s.delete(SCOPE_A, `k${k}`);
}

const factories: Array<{ name: string; make: () => StateStore }> = [
  { name: "StoreMemory", make: () => new StoreMemory() },
  { name: "StoreLibsql", make: () => new StoreLibsql({ url: ":memory:" }) },
];

for (const { name, make } of factories) {
  describe(`${name}: payload-free oplog accessors`, () => {
    it("count, head, and per-key evidence match a full read", async () => {
      const s = make();
      try {
        expect(await s.oplogCount()).toBe(0);
        expect(await s.oplogHead()).toBeNull();
        await script(s);
        const all = await s.readOplog();
        expect(all.length).toBeGreaterThan(1_000);
        expect(await s.oplogCount()).toBe(all.length);
        expect(await s.oplogHead()).toEqual({ id: all.at(-1)!.id, hash: all.at(-1)!.hash });

        const strip = (e: (typeof all)[number]) => ({
          id: e.id, ts: e.ts, op: e.op, scope: e.scope, key: e.key, hash: e.hash, prev_hash: e.prev_hash,
        });
        expect(await s.findOplogEntries("k3", SCOPE_A)).toEqual(
          all.filter((e) => e.key === "k3" && e.scope === SCOPE_A).map(strip),
        );
        // unscoped: every scope's entries for the key, oldest first
        const unscoped = await s.findOplogEntries("k7");
        expect(unscoped).toEqual(all.filter((e) => e.key === "k7").map(strip));
        expect(new Set(unscoped.map((e) => e.scope))).toEqual(new Set([SCOPE_A, SCOPE_B]));
        // evidence never carries payloads
        expect(JSON.stringify(unscoped)).not.toContain("payload-");
        expect(await s.findOplogEntries("never-written", SCOPE_A)).toEqual([]);
      } finally {
        await s.close();
      }
    });
  });
}

describe("no hot path loads the whole oplog", () => {
  let sdk: Kernel;
  let store: StoreLibsql;

  beforeEach(async () => {
    __resetKernelSingleton();
    store = new StoreLibsql({ url: ":memory:" });
    sdk = registerWorker("in-process", { workerName: "memwarden-bounded" }, { store });
    await script(store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    __resetKernelSingleton();
    await store.close();
  });

  it("oplog-count, oplog-head, oplog-find, and verify never call readOplog", async () => {
    const full = await store.readOplog();
    const spy = vi.spyOn(store, "readOplog");

    const count = await sdk.trigger<unknown, { count: number }>({
      function_id: "state::oplog-count",
      payload: {},
    });
    const head = await sdk.trigger<unknown, { id: number; hash: string }>({
      function_id: "state::oplog-head",
      payload: {},
    });
    const found = await sdk.trigger<unknown, { entries: Array<{ id: number }> }>({
      function_id: "state::oplog-find",
      payload: { key: "k9", scope: SCOPE_A },
    });
    const verdict = await sdk.trigger<unknown, { ok: boolean }>({
      function_id: "state::verify",
      payload: {},
    });

    expect(spy).not.toHaveBeenCalled();
    expect(count.count).toBe(full.length);
    expect(head).toEqual({ id: full.at(-1)!.id, hash: full.at(-1)!.hash });
    expect(found.entries.map((e) => e.id)).toEqual(
      full.filter((e) => e.key === "k9" && e.scope === SCOPE_A).map((e) => e.id),
    );
    expect(verdict.ok).toBe(true);
  });

  it("an empty log reports the zero head the receipts expect", async () => {
    const empty = new StoreLibsql({ url: ":memory:" });
    __resetKernelSingleton();
    const k = registerWorker("in-process", { workerName: "memwarden-empty" }, { store: empty });
    try {
      expect(
        await k.trigger({ function_id: "state::oplog-head", payload: {} }),
      ).toEqual({ id: 0, hash: "" });
      expect(
        await k.trigger({ function_id: "state::oplog-count", payload: {} }),
      ).toEqual({ count: 0 });
    } finally {
      await empty.close();
    }
  });

  it("compaction (dry run and real) never calls readOplog", async () => {
    const spy = vi.spyOn(store, "readOplog");
    const dry = await store.compactOplog({ dryRun: true, pruneSuperseded: true });
    const real = await store.compactOplog({ pruneSuperseded: true });
    expect(spy).not.toHaveBeenCalled();
    expect(dry.prunedCount).toBeGreaterThan(1_000);
    expect(real.prunedCount).toBe(dry.prunedCount);
    expect(real.erasedCount).toBe(dry.erasedCount);
    spy.mockRestore();
    expect(await store.verifyOplog()).toEqual({ ok: true });
  });
});

describe("StoreLibsql: paged verification and streaming compaction", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memwarden-bounded-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a tampered payload deep in the log (a later page)", async () => {
    const path = join(dir, "t.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    await script(s);
    expect(await s.verifyOplog()).toEqual({ ok: true });
    await s.close();

    const raw = createClient({ url: `file:${path}` });
    const target = await raw.execute(
      `SELECT id FROM oplog WHERE payload IS NOT NULL AND id > 1100 ORDER BY id LIMIT 1`,
    );
    const id = Number(target.rows[0]!.id);
    await raw.execute({ sql: `UPDATE oplog SET payload = ? WHERE id = ?`, args: ['{"forged":true}', id] });
    raw.close();

    const reopened = new StoreLibsql({ url: `file:${path}` });
    try {
      expect(await reopened.verifyOplog()).toEqual({ ok: false, brokenAt: id });
    } finally {
      await reopened.close();
    }
  });

  it("detects an unauthorized null past the first page", async () => {
    const path = join(dir, "n.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    await script(s);
    await s.close();

    const raw = createClient({ url: `file:${path}` });
    const target = await raw.execute(
      `SELECT id FROM oplog WHERE payload IS NOT NULL AND id > 700 ORDER BY id LIMIT 1`,
    );
    const id = Number(target.rows[0]!.id);
    await raw.execute({ sql: `UPDATE oplog SET payload = NULL WHERE id = ?`, args: [id] });
    raw.close();

    const reopened = new StoreLibsql({ url: `file:${path}` });
    try {
      expect(await reopened.verifyOplog()).toEqual({ ok: false, brokenAt: id });
    } finally {
      await reopened.close();
    }
  });

  it("streaming compaction plans exactly what StoreMemory plans (parity across pages)", async () => {
    const mem = new StoreMemory();
    const lib = new StoreLibsql({ url: `file:${join(dir, "p.db")}` });
    try {
      await script(mem);
      await script(lib);
      const [rm, rl] = [
        await mem.compactOplog({ pruneSuperseded: true }),
        await lib.compactOplog({ pruneSuperseded: true }),
      ];
      for (const k of ["entriesRewritten", "erasedCount", "prunedCount", "payloadBytesBefore", "payloadBytesAfter"] as const) {
        expect(rl[k]).toBe(rm[k]);
      }
      expect(rl.erasedCount).toBeGreaterThan(0);
      expect(await mem.verifyOplog()).toEqual({ ok: true });
      expect(await lib.verifyOplog()).toEqual({ ok: true });
      // identical per-entry decisions: which payloads survived, same commitments
      const shape = async (s: StateStore) =>
        (await s.readOplog()).map((e) => [e.id, e.op, e.payload === null, e.payload_hash]);
      const [ml, ll] = [await shape(mem), await shape(lib)];
      // the compact record's payload_hash embeds its own timestamp/head; compare the rest
      expect(ll.slice(0, -1)).toEqual(ml.slice(0, -1));
      // live values are untouched by the prune
      expect(await lib.get(SCOPE_A, "k39")).toEqual(await mem.get(SCOPE_A, "k39"));
      // a second pruning compaction finds nothing new
      const again = await lib.compactOplog({ pruneSuperseded: true });
      expect(again.prunedCount).toBe(0);
      expect(again.erasedCount).toBe(0);
      expect(await lib.verifyOplog()).toEqual({ ok: true });
    } finally {
      await mem.close();
      await lib.close();
    }
  });

  it("migrates a legacy v1 log larger than a page without carrying payload text", async () => {
    const path = join(dir, "legacy.db");
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
    let prev = GENESIS_PREV_HASH;
    const rows: Array<{ op: OplogOp; key: string; payload: unknown }> = [];
    for (let i = 0; i < 1_200; i++) {
      rows.push({ op: "set", key: `live${i % 30}`, payload: { gen: i, keep: `legacy-${i}` } });
    }
    rows.push({ op: "set", key: "gone", payload: { secret: "legacy-needle" } });
    rows.push({ op: "delete", key: "gone", payload: null });
    const stmts = rows.map((r, idx) => {
      const id = idx + 1;
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, idx)).toISOString();
      const hash = hashOplogEntry({ id, ts, op: r.op, scope: SCOPE_A, key: r.key, payload: r.payload, prev_hash: prev });
      const stmt = {
        sql: `INSERT INTO oplog (id, ts, op, scope, key, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, ts, r.op, SCOPE_A, r.key, r.payload === null ? null : JSON.stringify(r.payload), prev, hash],
      };
      prev = hash;
      return stmt;
    });
    await c.batch(stmts, "write");
    const now = new Date().toISOString();
    for (let k = 0; k < 30; k++) {
      await c.execute({
        sql: `INSERT INTO kv (scope, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        args: [SCOPE_A, `live${k}`, JSON.stringify({ gen: 1_170 + k }), now, now],
      });
    }
    const before = await c.execute(`SELECT id, payload FROM oplog WHERE key != 'gone' ORDER BY id`);
    c.close();

    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      expect(await s.verifyOplog()).toEqual({ ok: true }); // all-v1 chain
      const r = await s.compactOplog();
      expect(r.erasedCount).toBe(1);
      expect(r.entriesRewritten).toBe(rows.length); // every v1 row re-versioned
      expect(await s.verifyOplog()).toEqual({ ok: true });
      const log = await s.readOplog();
      expect(log.every((e) => e.v === 2)).toBe(true);
      expect(JSON.stringify(log)).not.toContain("legacy-needle");
    } finally {
      await s.close();
    }
    // kept payloads were left in place, byte for byte (never re-encoded)
    const c2 = createClient({ url: `file:${path}` });
    const after = await c2.execute(`SELECT id, payload FROM oplog WHERE key != 'gone' AND op != 'compact' ORDER BY id`);
    c2.close();
    expect(after.rows.map((r) => [Number(r.id), r.payload])).toEqual(
      before.rows.map((r) => [Number(r.id), r.payload]),
    );
  });
});

describe("StoreLibsql: incremental verification for receipts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memwarden-incr-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function tamper(path: string, sql: string, args: Array<string | number | null>) {
    const raw = createClient({ url: `file:${path}` });
    await raw.execute({ sql, args });
    raw.close();
  }

  it("extends a recent full walk over appended entries, and catches a forged append", async () => {
    const path = join(dir, "i.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      await script(s);
      expect(await s.verifyOplog()).toEqual({ ok: true }); // full walk seeds the cache
      await s.set(SCOPE_A, "fresh", { v: 1 });
      await s.set(SCOPE_A, "fresh2", { v: 2 });
      expect(await s.verifyOplog({ incremental: true })).toEqual({ ok: true });

      await s.set(SCOPE_A, "fresh3", { v: 3 });
      const head = (await s.oplogHead())!;
      await tamper(path, `UPDATE oplog SET payload = ? WHERE id = ?`, ['{"v":999}', head.id]);
      expect(await s.verifyOplog({ incremental: true })).toEqual({ ok: false, brokenAt: head.id });
    } finally {
      await s.close();
    }
  });

  it("an explicit (full) verify still re-walks history an incremental one trusted", async () => {
    const path = join(dir, "f.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      await script(s);
      expect(await s.verifyOplog()).toEqual({ ok: true });
      await tamper(path, `UPDATE oplog SET payload = ? WHERE id = ?`, ['{"old":"forged"}', 10]);
      await s.set(SCOPE_A, "after", { v: 1 });
      // the receipt path trusts the walk it did moments ago (documented window)
      expect(await s.verifyOplog({ incremental: true })).toEqual({ ok: true });
      // explicit verification never does
      expect(await s.verifyOplog()).toEqual({ ok: false, brokenAt: 10 });
    } finally {
      await s.close();
    }
  });

  it("falls back to a full walk after an erase, and after the reuse window", async () => {
    const path = join(dir, "e.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      await script(s);
      expect(await s.verifyOplog()).toEqual({ ok: true });
      // erase rewrites history in place: the cached walk no longer applies
      await s.delete(SCOPE_A, "k20");
      expect((await s.eraseOplogPayloads(SCOPE_A, "k20")).erased).toBeGreaterThan(0);
      await tamper(path, `UPDATE oplog SET payload = ? WHERE id = ?`, ['{"old":"forged"}', 12]);
      expect(await s.verifyOplog({ incremental: true })).toEqual({ ok: false, brokenAt: 12 });

      // repair, re-seed, then let the reuse window lapse
      await s.close();
      const s2 = new StoreLibsql({ url: `file:${join(dir, "w.db")}` });
      await script(s2);
      expect(await s2.verifyOplog()).toEqual({ ok: true });
      await tamper(join(dir, "w.db"), `UPDATE oplog SET payload = ? WHERE id = ?`, ['{"x":1}', 15]);
      const now = performance.now();
      vi.spyOn(performance, "now").mockReturnValue(now + 61_000);
      expect(await s2.verifyOplog({ incremental: true })).toEqual({ ok: false, brokenAt: 15 });
      await s2.close();
    } finally {
      await s.close();
    }
  });
});

describe("StoreLibsql: review follow-ups", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memwarden-review-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function tamper(path: string, sql: string, args: Array<string | number | null>) {
    const raw = createClient({ url: `file:${path}` });
    await raw.execute({ sql, args });
    raw.close();
  }

  it("compaction REFUSES to re-anchor forged history (it used to launder it)", async () => {
    const path = join(dir, "forged.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    await script(s);
    await s.close();
    await tamper(path, `UPDATE oplog SET payload = ? WHERE id = ?`, ['{"forged":true}', 42]);

    const reopened = new StoreLibsql({ url: `file:${path}` });
    try {
      await expect(reopened.compactOplog({ pruneSuperseded: true })).rejects.toBeInstanceOf(
        OplogChainBrokenError,
      );
      await expect(reopened.compactOplog({ dryRun: true })).rejects.toMatchObject({ brokenAt: 42 });
      // nothing was rewritten: the evidence is still there to find
      expect(await reopened.verifyOplog()).toEqual({ ok: false, brokenAt: 42 });
    } finally {
      await reopened.close();
    }
  });

  it("the in-memory store refuses the same way (parity)", async () => {
    const s = new StoreMemory();
    await script(s);
    const log = (s as unknown as { oplog: Array<{ payload: unknown }> }).oplog;
    log[10] = { ...log[10]!, payload: { forged: true } };
    await expect(s.compactOplog()).rejects.toMatchObject({ brokenAt: 11 });
  });

  it("an anchor row rewritten after a full walk forces the next incremental check to re-walk", async () => {
    const path = join(dir, "anchor.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      await script(s);
      expect(await s.verifyOplog()).toEqual({ ok: true });
      const head = (await s.oplogHead())!;
      await tamper(path, `UPDATE oplog SET hash = ? WHERE id = ?`, ["f".repeat(64), head.id]);
      expect(await s.verifyOplog({ incremental: true })).toEqual({ ok: false, brokenAt: head.id });
    } finally {
      await s.close();
    }
  });

  it("pages close on a byte budget: many large rows still verify, and a forged one is found", async () => {
    const path = join(dir, "big.db");
    const s = new StoreLibsql({ url: `file:${path}` });
    try {
      const blob = "b".repeat(1_000_000);
      for (let i = 0; i < 40; i++) await s.set(SCOPE_A, `big${i % 3}`, { i, blob });
      expect(await s.verifyOplog()).toEqual({ ok: true });
      const r = await s.compactOplog({ pruneSuperseded: true });
      expect(r.prunedCount).toBe(37);
      expect(await s.verifyOplog()).toEqual({ ok: true });
    } finally {
      await s.close();
    }
  });
});
