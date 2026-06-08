//
// THE PARITY SUITE — asserts the in-memory and libSQL stores behave
// identically, so tests can run against the fast memory store while
// production uses libSQL.
//
// A single operation script (set / get / update / delete / list, exercising
// scopes, last-write-wins overwrites, missing keys, update-from-{}, idempotent
// deletes, and list prefix/exact-scope filtering) is executed step by step
// against BOTH StateStore implementations:
//
// - StoreMemory       (the dependency-free the original implementation KV mirror)
// - StoreLibsql(:memory:) (the durable libSQL successor)
//
// After every step we capture the observable result of each store and assert
// the two are BYTE-IDENTICAL via canonical JSON. If the two stores ever
// diverge on any observable result, the libSQL successor is not a faithful
// drop-in for the original KV and Phase 0 has not been met. The store under
// test is opaque: only the five public methods are observed.

import { describe, it, expect } from "vitest";
import { StoreMemory } from "../src/state/store-memory.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { canonicalize, type StateStore } from "../src/state/store.js";

// --- the operation script -------------------------------------------------
//
// Each step is a closure that drives one store and returns the observable
// result of that operation (or a follow-up read of it). The harness runs the
// identical closure against both stores and compares canonical bytes. Steps
// deliberately cover every observable corner of the StateKV contract.

type Step = {
  readonly name: string;
  readonly run: (s: StateStore) => Promise<unknown>;
};

const OBS_A = "mem:obs:sess-A";
const OBS_B = "mem:obs:sess-B";
const SESSIONS = "mem:sessions";

const SCRIPT: readonly Step[] = [
  // --- get on a never-written key: null, never undefined, never throws ----
  { name: "get miss returns null", run: (s) => s.get(SESSIONS, "ghost") },
  { name: "list unknown scope returns []", run: (s) => s.list("mem:never") },

  // --- set: upsert, returns the written value -----------------------------
  {
    name: "set returns written value",
    run: (s) => s.set(SESSIONS, "s1", { id: "s1", observationCount: 0, project: "p" }),
  },
  { name: "get after set", run: (s) => s.get(SESSIONS, "s1") },

  // --- last-write-wins overwrite ------------------------------------------
  {
    name: "overwrite same key (LWW) returns new value",
    run: (s) => s.set(SESSIONS, "s1", { id: "s1", observationCount: 1, project: "p" }),
  },
  { name: "get after overwrite reads the latest", run: (s) => s.get(SESSIONS, "s1") },

  // --- update on a MISSING key starts from {} -----------------------------
  {
    name: "update missing key starts from {}",
    run: (s) =>
      s.update(SESSIONS, "fresh", [
        { type: "set", path: "status", value: "active" },
      ]),
  },
  { name: "get the update-created key", run: (s) => s.get(SESSIONS, "fresh") },

  // --- update merges flat set ops onto an existing record -----------------
  {
    name: "update merges onto existing",
    run: (s) =>
      s.update(SESSIONS, "s1", [
        { type: "set", path: "observationCount", value: 5 },
        { type: "set", path: "endedAt", value: "2026-06-06T00:00:00.000Z" },
      ]),
  },
  { name: "get after merge update", run: (s) => s.get(SESSIONS, "s1") },

  // --- update ignores non-"set" op types ----------------------------------
  {
    name: "update ignores unknown op types",
    run: (s) =>
      s.update(SESSIONS, "s1", [
        { type: "push", path: "observationCount", value: 99 },
        { type: "inc", path: "observationCount", value: 1 },
        { type: "set", path: "flag", value: true },
      ]),
  },

  // --- update over a non-object value resets to {} (then applies ops) -----
  { name: "seed a scalar value", run: (s) => s.set(SESSIONS, "scalar", 42) },
  {
    name: "update over scalar resets to {} base",
    run: (s) =>
      s.update(SESSIONS, "scalar", [{ type: "set", path: "x", value: 1 }]),
  },
  // --- update over an array value resets to {} -----------------------------
  { name: "seed an array value", run: (s) => s.set(SESSIONS, "arr", [1, 2, 3]) },
  {
    name: "update over array resets to {} base",
    run: (s) => s.update(SESSIONS, "arr", [{ type: "set", path: "y", value: 2 }]),
  },

  // --- scope isolation + list (values only, exact match, insertion order) -
  { name: "set obs A o1", run: (s) => s.set(OBS_A, "o1", { i: 1 }) },
  { name: "set obs A o2", run: (s) => s.set(OBS_A, "o2", { i: 2 }) },
  { name: "set obs A o3", run: (s) => s.set(OBS_A, "o3", { i: 3 }) },
  { name: "set obs B o1 (different scope)", run: (s) => s.set(OBS_B, "o1", { i: 100 }) },
  { name: "list obs A (exact scope, insertion order)", run: (s) => s.list(OBS_A) },
  { name: "list obs B is isolated", run: (s) => s.list(OBS_B) },

  // --- in-place update preserves list insertion order ----------------------
  { name: "overwrite obs A o1 in place", run: (s) => s.set(OBS_A, "o1", { i: 11 }) },
  { name: "list obs A keeps original order after in-place overwrite", run: (s) => s.list(OBS_A) },

  // --- list "prefix" must be EXACT-MATCH, not a prefix scan ---------------
  // mem:obs:sess-A is NOT a prefix of mem:obs:sess-A-extra; these are
  // independent opaque scopes. Writing the longer one must not leak into
  // the shorter one's list, and vice versa.
  { name: "set a longer-prefixed scope", run: (s) => s.set("mem:obs:sess-A-extra", "z", { z: 1 }) },
  { name: "list short scope unaffected by longer-prefixed scope", run: (s) => s.list(OBS_A) },
  { name: "list the longer scope returns only its own value", run: (s) => s.list("mem:obs:sess-A-extra") },

  // --- delete: idempotent, no error on missing, removes the value ---------
  { name: "delete obs A o2", run: (s) => s.delete(OBS_A, "o2") },
  { name: "list obs A after delete", run: (s) => s.list(OBS_A) },
  { name: "get deleted key returns null", run: (s) => s.get(OBS_A, "o2") },
  { name: "delete obs A o2 again (idempotent no-op)", run: (s) => s.delete(OBS_A, "o2") },
  { name: "delete a never-existing key (idempotent)", run: (s) => s.delete(OBS_A, "never") },
  { name: "list obs A stable after redundant deletes", run: (s) => s.list(OBS_A) },

  // --- delete-then-reinsert: new value lands at the TAIL of insertion order
  { name: "reinsert obs A o2 after delete", run: (s) => s.set(OBS_A, "o2", { i: 222 }) },
  { name: "list obs A places reinserted key at the tail", run: (s) => s.list(OBS_A) },

  // --- nested/structured values round-trip identically --------------------
  {
    name: "set deeply nested value",
    run: (s) =>
      s.set("mem:memories", "deep", {
        tags: ["a", "b"],
        meta: { nested: { n: 1, list: [{ k: "v" }] } },
        flag: false,
        nullable: null,
      }),
  },
  { name: "get deeply nested value", run: (s) => s.get("mem:memories", "deep") },

  // --- empty-string scope and key are valid opaque identifiers ------------
  { name: "set empty-string key", run: (s) => s.set("mem:memories", "", { empty: "key" }) },
  { name: "get empty-string key", run: (s) => s.get("mem:memories", "") },
  { name: "set empty-string scope", run: (s) => s.set("", "k", { empty: "scope" }) },
  { name: "list empty-string scope", run: (s) => s.list("") },

  // --- final full-scope snapshots: every populated scope, listed ----------
  { name: "final list sessions", run: (s) => s.list(SESSIONS) },
  { name: "final list obs A", run: (s) => s.list(OBS_A) },
  { name: "final list obs B", run: (s) => s.list(OBS_B) },
  { name: "final list memories", run: (s) => s.list("mem:memories") },
];

describe("KV PARITY SUITE: StoreMemory vs StoreLibsql(:memory:) byte-identical", () => {
  it("produces byte-identical observable results for every operation in the script", async () => {
    const mem = new StoreMemory();
    const sql = new StoreLibsql({ url: ":memory:" });

    try {
      for (const step of SCRIPT) {
        const memResult = await step.run(mem);
        const sqlResult = await step.run(sql);
        // Byte-identical = canonical JSON equality. canonicalize() sorts
        // object keys so insertion-order differences in the encoding cannot
        // produce a spurious diff; any real divergence (a different value, a
        // missing/extra field, wrong null-vs-undefined, wrong ordering of a
        // LIST array) still fails because canonicalize preserves array order.
        const memBytes = canonicalize(memResult ?? null);
        const sqlBytes = canonicalize(sqlResult ?? null);
        expect(
          sqlBytes,
          `parity divergence at step "${step.name}":\n  StoreMemory  = ${memBytes}\n  StoreLibsql  = ${sqlBytes}`,
        ).toBe(memBytes);
      }
    } finally {
      await mem.close();
      await sql.close();
    }
  });

  it("oplog is byte-identical modulo non-deterministic fields (id/op/scope/key/payload/chain)", async () => {
    // The oplog records the SAME sequence of mutations in both stores. The
    // timestamp (ts) and therefore the hash are wall-clock dependent and will
    // differ; everything that is a deterministic function of the operation
    // script must match exactly, and BOTH chains must self-verify.
    const mem = new StoreMemory();
    const sql = new StoreLibsql({ url: ":memory:" });
    try {
      for (const step of SCRIPT) {
        await step.run(mem);
        await step.run(sql);
      }
      const memLog = await mem.readOplog();
      const sqlLog = await sql.readOplog();

      const project = (e: { id: number; op: string; scope: string; key: string; payload: unknown }) => ({
        id: e.id,
        op: e.op,
        scope: e.scope,
        key: e.key,
        payload: e.payload ?? null,
      });

      expect(sqlLog.map(project)).toEqual(memLog.map(project));
      expect(await mem.verifyOplog()).toEqual({ ok: true });
      expect(await sql.verifyOplog()).toEqual({ ok: true });
      // Same number of mutations recorded; redundant deletes added no rows.
      expect(sqlLog.length).toBe(memLog.length);
    } finally {
      await mem.close();
      await sql.close();
    }
  });

  it("mutation events are byte-identical across the two stores", async () => {
    // The kernel drives type:"state" triggers off these events, so their
    // shape (scope/key/event_type and the presence/absence of old_value /
    // new_value) must match between the two stores exactly.
    const mem = new StoreMemory();
    const sql = new StoreLibsql({ url: ":memory:" });
    const memEvents: unknown[] = [];
    const sqlEvents: unknown[] = [];
    mem.onMutation((e) => memEvents.push(e));
    sql.onMutation((e) => sqlEvents.push(e));
    try {
      for (const step of SCRIPT) {
        await step.run(mem);
        await step.run(sql);
      }
      expect(canonicalize(sqlEvents)).toBe(canonicalize(memEvents));
    } finally {
      await mem.close();
      await sql.close();
    }
  });
});
