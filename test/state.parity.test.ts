//
// Parity + contract tests for the STATE layer. Runs StoreMemory and
// StoreLibsql (in-memory libSQL) through identical scenarios to prove they
// share the original observable KV semantics, plus dedicated tests for the
// `update` op semantics, mutation events, the oplog hash chain, and the
// StateKV trigger wiring.

import { describe, it, expect } from "vitest";
import { StoreMemory } from "../src/state/store-memory.js";
import type { StateStore, StateMutationEvent } from "../src/state/store.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";

type Factory = { name: string; make: () => Promise<StateStore> };

const factories: Factory[] = [
  { name: "StoreMemory", make: async () => new StoreMemory() },
  {
    name: "StoreLibsql",
    make: async () => {
      const { StoreLibsql } = await import("../src/state/store-libsql.js");
      return new StoreLibsql({ url: ":memory:" });
    },
  },
];

for (const { name, make } of factories) {
  describe(`${name} KV semantics`, () => {
    it("get returns null (not undefined) on miss and never throws", async () => {
      const s = await make();
      const v = await s.get("mem:none", "nope");
      expect(v).toBeNull();
      await s.close();
    });

    it("set upserts last-write-wins and returns the written value", async () => {
      const s = await make();
      const r1 = await s.set("mem:memories", "a", { n: 1 });
      expect(r1).toEqual({ n: 1 });
      await s.set("mem:memories", "a", { n: 2 });
      expect(await s.get("mem:memories", "a")).toEqual({ n: 2 });
      await s.close();
    });

    it("update reads-or-{} and applies flat set ops, returning the merged record", async () => {
      const s = await make();
      // update on a missing key starts from {}
      const created = await s.update<Record<string, unknown>>("mem:sessions", "s1", [
        { type: "set", path: "status", value: "active" },
      ]);
      expect(created).toEqual({ status: "active" });
      // update merges onto existing
      await s.set("mem:sessions", "s2", { id: "s2", observationCount: 0 });
      const merged = await s.update<Record<string, unknown>>("mem:sessions", "s2", [
        { type: "set", path: "observationCount", value: 1 },
        { type: "set", path: "updatedAt", value: "2026-06-06" },
      ]);
      expect(merged).toEqual({ id: "s2", observationCount: 1, updatedAt: "2026-06-06" });
      expect(await s.get("mem:sessions", "s2")).toEqual(merged);
      await s.close();
    });

    it("update ignores non-set op types", async () => {
      const s = await make();
      await s.set("mem:sessions", "s3", { a: 1 });
      const r = await s.update<Record<string, unknown>>("mem:sessions", "s3", [
        { type: "push", path: "a", value: 9 },
        { type: "set", path: "b", value: 2 },
      ]);
      expect(r).toEqual({ a: 1, b: 2 });
      await s.close();
    });

    it("delete is idempotent and never errors on missing", async () => {
      const s = await make();
      await expect(s.delete("mem:memories", "ghost")).resolves.toBeUndefined();
      await s.set("mem:memories", "x", { v: 1 });
      await s.delete("mem:memories", "x");
      expect(await s.get("mem:memories", "x")).toBeNull();
      await s.delete("mem:memories", "x");
      await s.close();
    });

    it("list returns values only, exact scope match, insertion order, [] on unknown", async () => {
      const s = await make();
      expect(await s.list("mem:obs:unknown")).toEqual([]);
      await s.set(KV.observations("abc"), "o1", { i: 1 });
      await s.set(KV.observations("abc"), "o2", { i: 2 });
      await s.set(KV.observations("def"), "o3", { i: 3 });
      // exact-match: abc and def are unrelated scopes
      expect(await s.list(KV.observations("abc"))).toEqual([{ i: 1 }, { i: 2 }]);
      expect(await s.list(KV.observations("def"))).toEqual([{ i: 3 }]);
      // insertion order preserved across an in-place update
      await s.set(KV.observations("abc"), "o1", { i: 11 });
      expect(await s.list(KV.observations("abc"))).toEqual([{ i: 11 }, { i: 2 }]);
      await s.close();
    });

    it("stored values are isolated from caller mutation", async () => {
      const s = await make();
      const obj = { tags: ["a"] };
      await s.set("mem:memories", "iso", obj);
      obj.tags.push("b");
      expect(await s.get<{ tags: string[] }>("mem:memories", "iso")).toEqual({ tags: ["a"] });
      await s.close();
    });
  });

  describe(`${name} mutation events`, () => {
    it("emits set/update/delete events with old/new values for the right scope", async () => {
      const s = await make();
      const events: StateMutationEvent[] = [];
      const off = s.onMutation((e) => {
        if (e.scope === KV.sessions) events.push(e);
      });
      await s.set(KV.sessions, "s1", { observationCount: 0 });
      await s.update(KV.sessions, "s1", [{ type: "set", path: "observationCount", value: 1 }]);
      await s.delete(KV.sessions, "s1");
      // scope filter: a write to another scope must not notify this listener
      await s.set("mem:memories", "m1", { x: 1 });
      off();
      expect(events.map((e) => e.event_type)).toEqual(["set", "update", "delete"]);
      const setEvent = events[0]!;
      expect(setEvent.old_value).toBeUndefined();
      expect(setEvent.new_value).toEqual({ observationCount: 0 });
      const updEvent = events[1]!;
      expect((updEvent.old_value as { observationCount: number }).observationCount).toBe(0);
      expect((updEvent.new_value as { observationCount: number }).observationCount).toBe(1);
      const delEvent = events[2]!;
      expect((delEvent.old_value as { observationCount: number }).observationCount).toBe(1);
      expect(delEvent.new_value).toBeUndefined();
      await s.close();
    });

    it("unsubscribe stops delivery and a throwing listener does not break writes", async () => {
      const s = await make();
      const seen: string[] = [];
      const off = s.onMutation(() => {
        throw new Error("boom");
      });
      s.onMutation((e) => seen.push(e.key));
      await expect(s.set("mem:memories", "k", { v: 1 })).resolves.toEqual({ v: 1 });
      off();
      await s.set("mem:memories", "k2", { v: 2 });
      expect(seen).toEqual(["k", "k2"]);
      await s.close();
    });
  });

  describe(`${name} oplog`, () => {
    it("records an entry per mutation and the hash chain verifies", async () => {
      const s = await make();
      await s.set("mem:memories", "a", { v: 1 });
      await s.update("mem:memories", "a", [{ type: "set", path: "w", value: 2 }]);
      await s.delete("mem:memories", "a");
      await s.delete("mem:memories", "absent"); // idempotent no-op: no oplog row
      const log = await s.readOplog();
      expect(log.map((e) => e.op)).toEqual(["set", "update", "delete"]);
      expect(log.map((e) => e.id)).toEqual([1, 2, 3]);
      expect(log[0]!.prev_hash).toBe("");
      expect(log[1]!.prev_hash).toBe(log[0]!.hash);
      expect(log[2]!.prev_hash).toBe(log[1]!.hash);
      expect(await s.verifyOplog()).toEqual({ ok: true });
      // sinceId filters
      expect((await s.readOplog(1)).map((e) => e.id)).toEqual([2, 3]);
      await s.close();
    });
  });
}

describe("StateKV over a trigger sink", () => {
  // A trivial in-process sink routing the five state:: ids to a StoreMemory,
  // mirroring how the kernel will route them.
  function makeSink(store: StoreMemory) {
    return {
      async trigger<P = unknown, R = unknown>(opts: { function_id: string; payload: P }): Promise<R> {
        const p = opts.payload as Record<string, unknown>;
        switch (opts.function_id) {
          case "state::get":
            return (await store.get(p.scope as string, p.key as string)) as R;
          case "state::set":
            return (await store.set(p.scope as string, p.key as string, p.value)) as R;
          case "state::update":
            return (await store.update(
              p.scope as string,
              p.key as string,
              p.ops as Array<{ type: string; path: string; value?: unknown }>,
            )) as R;
          case "state::delete":
            return (await store.delete(p.scope as string, p.key as string)) as R;
          case "state::list":
            return (await store.list(p.scope as string)) as R;
          default:
            throw Object.assign(new Error(`unregistered: ${opts.function_id}`), {
              code: "FUNCTION_NOT_FOUND",
              function_id: opts.function_id,
            });
        }
      },
    };
  }

  it("round-trips the five methods through the trigger chokepoint", async () => {
    const store = new StoreMemory();
    const kv = new StateKV(makeSink(store));
    expect(await kv.get("mem:sessions", "x")).toBeNull();
    await kv.set("mem:sessions", "x", { id: "x", observationCount: 0 });
    await kv.update("mem:sessions", "x", [{ type: "set", path: "observationCount", value: 5 }]);
    expect(await kv.get<{ observationCount: number }>("mem:sessions", "x")).toEqual({
      id: "x",
      observationCount: 5,
    });
    expect(await kv.list("mem:sessions")).toEqual([{ id: "x", observationCount: 5 }]);
    await kv.delete("mem:sessions", "x");
    expect(await kv.get("mem:sessions", "x")).toBeNull();
    await store.close();
  });
});
