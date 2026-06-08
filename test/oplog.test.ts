//
// Oplog suite: the append-only, hash-chained mutation log that makes
// memwarden's state tamper-evident (and the substrate any future signing
// layer would build on). Covers:
//
// 1. append-only ordering   — one row per real mutation, ids strictly
// increasing, genesis links to the empty-string prev_hash, each row's
// prev_hash == the prior row's hash; idempotent delete-no-ops add no row.
// 2. hash-chain integrity    — verifyOplog() reports the chain intact, and
// tampering (mutating a payload, reordering, dropping a link, or forging
// a hash) is DETECTED at the first broken entry.
// 3. replay reproduces KV    — folding the oplog from genesis rebuilds the
// exact live KV state the store reports via list().
//
// The first two run against both StoreMemory and StoreLibsql(:memory:) since
// both implement the same StateStore oplog surface. Tamper detection drives
// the pure verifyChain() helper directly (we never mutate a store's private
// log; we build a doctored copy of the read-back entries).

import { describe, it, expect } from "vitest";
import { StoreMemory } from "../src/state/store-memory.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import {
  GENESIS_PREV_HASH,
  hashOplogEntry,
  verifyChain,
} from "../src/state/oplog.js";
import {
  applyUpdateOps,
  canonicalize,
  type OplogEntry,
  type StateStore,
  type UpdateOp,
} from "../src/state/store.js";

type Factory = { name: string; make: () => StateStore };

const factories: Factory[] = [
  { name: "StoreMemory", make: () => new StoreMemory() },
  { name: "StoreLibsql", make: () => new StoreLibsql({ url: ":memory:" }) },
];

// A mutation script reused across the suite. Includes a redundant delete and a
// delete of a never-existing key (both idempotent no-ops that MUST NOT append
// an oplog row).
async function runMutations(s: StateStore): Promise<void> {
  await s.set("mem:memories", "a", { v: 1 });
  await s.set("mem:memories", "b", { v: 2 });
  await s.update("mem:memories", "a", [{ type: "set", path: "w", value: 9 }]);
  await s.set("mem:sessions", "s1", { observationCount: 0 });
  await s.delete("mem:memories", "b");
  await s.delete("mem:memories", "b"); // idempotent no-op: no oplog row
  await s.delete("mem:memories", "ghost"); // never existed: no oplog row
  await s.update("mem:sessions", "s1", [
    { type: "set", path: "observationCount", value: 3 },
  ]);
}

for (const { name, make } of factories) {
  describe(`${name} oplog: append-only ordering`, () => {
    it("records exactly one row per real mutation, ids strictly increasing", async () => {
      const s = make();
      try {
        await runMutations(s);
        const log = await s.readOplog();
        // 5 real mutations: set a, set b, update a, set s1, delete b,
        // update s1. The two redundant deletes appended nothing.
        expect(log.map((e) => e.op)).toEqual([
          "set",
          "set",
          "update",
          "set",
          "delete",
          "update",
        ]);
        const ids = log.map((e) => e.id);
        expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
        for (let i = 1; i < ids.length; i++) {
          expect(ids[i]! > ids[i - 1]!).toBe(true);
        }
      } finally {
        await s.close();
      }
    });

    it("links genesis to the empty-string prev_hash and chains every entry", async () => {
      const s = make();
      try {
        await runMutations(s);
        const log = await s.readOplog();
        expect(log.length).toBeGreaterThan(1);
        expect(log[0]!.prev_hash).toBe(GENESIS_PREV_HASH);
        expect(GENESIS_PREV_HASH).toBe("");
        for (let i = 1; i < log.length; i++) {
          expect(log[i]!.prev_hash).toBe(log[i - 1]!.hash);
        }
      } finally {
        await s.close();
      }
    });

    it("sinceId reads only entries after the given id (exclusive)", async () => {
      const s = make();
      try {
        await runMutations(s);
        const all = await s.readOplog();
        const tail = await s.readOplog(3);
        expect(tail.map((e) => e.id)).toEqual([4, 5, 6]);
        // sinceId past the end yields nothing; sinceId 0 yields everything.
        expect(await s.readOplog(999)).toEqual([]);
        expect((await s.readOplog(0)).length).toBe(all.length);
      } finally {
        await s.close();
      }
    });

    it("delete records null payload; set/update record the post-mutation value", async () => {
      const s = make();
      try {
        await s.set("mem:memories", "k", { v: 1 });
        await s.update("mem:memories", "k", [{ type: "set", path: "v", value: 2 }]);
        await s.delete("mem:memories", "k");
        const log = await s.readOplog();
        expect(log[0]!.payload).toEqual({ v: 1 });
        expect(log[1]!.payload).toEqual({ v: 2 });
        expect(log[2]!.op).toBe("delete");
        expect(log[2]!.payload).toBeNull();
      } finally {
        await s.close();
      }
    });
  });

  describe(`${name} oplog: hash-chain integrity (tamper detection)`, () => {
    it("verifyOplog reports an intact chain on an untouched log", async () => {
      const s = make();
      try {
        await runMutations(s);
        expect(await s.verifyOplog()).toEqual({ ok: true });
      } finally {
        await s.close();
      }
    });

    it("detects a tampered PAYLOAD at the edited entry", async () => {
      const s = make();
      try {
        await runMutations(s);
        const log = await s.readOplog();
        // Forge a copy with entry #3's payload silently altered. Its stored
        // hash no longer matches a fresh recomputation -> broken at id 3.
        const target = log[2]!;
        const doctored: OplogEntry[] = log.map((e) =>
          e.id === target.id ? { ...e, payload: { w: 1337 } } : { ...e },
        );
        expect(verifyChain(doctored)).toBe(target.id);
      } finally {
        await s.close();
      }
    });

    it("detects a DROPPED entry (broken prev_hash link)", async () => {
      const s = make();
      try {
        await runMutations(s);
        const log = await s.readOplog();
        // Remove entry #3. Entry #4 now points its prev_hash at a hash that is
        // no longer the immediately-preceding entry's hash.
        const withGap = log.filter((e) => e.id !== 3);
        const brokenAt = verifyChain(withGap);
        expect(brokenAt).toBe(4);
      } finally {
        await s.close();
      }
    });

    it("detects REORDERED entries", async () => {
      const s = make();
      try {
        await runMutations(s);
        const log = await s.readOplog();
        const reordered = [log[1]!, log[0]!, ...log.slice(2)];
        // First entry now has id 2 with a non-genesis prev_hash -> broken at 2.
        expect(verifyChain(reordered)).toBe(2);
      } finally {
        await s.close();
      }
    });

    it("detects a FORGED hash (attacker recomputes payload but not the chain link)", async () => {
      const s = make();
      try {
        await runMutations(s);
        const log = await s.readOplog();
        const target = log[1]!;
        // Attacker edits the payload AND recomputes that entry's own hash so
        // it is internally consistent, but cannot fix the NEXT entry's
        // prev_hash without recomputing the rest of the chain. Detection
        // therefore surfaces at the following entry.
        const forgedPayload = { v: 999 };
        const forgedHash = hashOplogEntry({
          id: target.id,
          ts: target.ts,
          op: target.op,
          scope: target.scope,
          key: target.key,
          payload: forgedPayload,
          prev_hash: target.prev_hash,
        });
        const doctored: OplogEntry[] = log.map((e) =>
          e.id === target.id
            ? { ...e, payload: forgedPayload, hash: forgedHash }
            : { ...e },
        );
        // The entry after the forged one still carries the ORIGINAL prev_hash.
        expect(verifyChain(doctored)).toBe(target.id + 1);
      } finally {
        await s.close();
      }
    });
  });

  describe(`${name} oplog: replay reproduces KV state`, () => {
    it("folding the oplog from genesis rebuilds the exact live KV state", async () => {
      const s = make();
      try {
        await runMutations(s);
        // Extra churn so replay must honor overwrites + deletes + reinserts.
        await s.set("mem:memories", "a", { v: 100, w: 9 });
        await s.delete("mem:sessions", "s1");
        await s.set("mem:sessions", "s2", { id: "s2" });

        const log = await s.readOplog();
        const replayed = replay(log);

        // For every scope the replay produced, the store's live list() must
        // match the replayed values exactly (values only, insertion order).
        for (const [scope, keyMap] of replayed) {
          const expected = Array.from(keyMap.values());
          const actual = await s.list(scope);
          expect(canonicalize(actual)).toBe(canonicalize(expected));
        }
        // And no scope the store reports is missing from the replay: probe the
        // scopes we touched.
        for (const scope of ["mem:memories", "mem:sessions"]) {
          const actual = await s.list(scope);
          const expected = Array.from(replayed.get(scope)?.values() ?? []);
          expect(canonicalize(actual)).toBe(canonicalize(expected));
        }
      } finally {
        await s.close();
      }
    });
  });
}

// Pure reducer: fold an ordered oplog into the KV state it represents.
// Mirrors the store write semantics exactly:
// - set    : upsert value (insertion order = first-seen key order)
// - update : payload IS the already-merged post-update record (the store
// logs the result, not the ops), so it is a plain upsert too
// - delete : remove the key
// Returns Map<scope, Map<key, value>> preserving key insertion order, which is
// what list(scope) observes.
function replay(log: readonly OplogEntry[]): Map<string, Map<string, unknown>> {
  const state = new Map<string, Map<string, unknown>>();
  for (const entry of log) {
    let scopeMap = state.get(entry.scope);
    if (!scopeMap) {
      scopeMap = new Map<string, unknown>();
      state.set(entry.scope, scopeMap);
    }
    if (entry.op === "delete") {
      scopeMap.delete(entry.key);
    } else {
      // set + update both store the post-mutation value as payload.
      scopeMap.set(entry.key, entry.payload);
    }
  }
  return state;
}

// Sanity: the pure helpers the stores rely on behave as the stores assume.
describe("oplog pure helpers", () => {
  it("hashOplogEntry is deterministic and excludes the hash field itself", () => {
    const fields = {
      id: 1,
      ts: "2026-06-06T00:00:00.000Z",
      op: "set" as const,
      scope: "mem:memories",
      key: "a",
      payload: { b: 2, a: 1 },
      prev_hash: GENESIS_PREV_HASH,
    };
    const h1 = hashOplogEntry(fields);
    const h2 = hashOplogEntry({ ...fields, payload: { a: 1, b: 2 } });
    // Canonicalization sorts keys: payload field order does not change the hash.
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // A different value DOES change the hash.
    expect(hashOplogEntry({ ...fields, payload: { a: 1, b: 3 } })).not.toBe(h1);
  });

  it("verifyChain returns null on an empty log", () => {
    expect(verifyChain([])).toBeNull();
  });

  it("applyUpdateOps honors only type:set and mutates flat top-level fields", () => {
    const ops: UpdateOp[] = [
      { type: "set", path: "a", value: 1 },
      { type: "push", path: "a", value: 2 },
      { type: "set", path: "b", value: { nested: true } },
    ];
    expect(applyUpdateOps({}, ops)).toEqual({ a: 1, b: { nested: true } });
  });
});
