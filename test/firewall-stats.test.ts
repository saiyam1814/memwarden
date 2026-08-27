//
// The evidence surface: what the firewall actually did.
//
// This exists because memwarden blocked stale memory for six weeks on a real
// install and never once said so. Silent protection reads as no protection, and
// a set-and-forget tool whose value is never shown gets uninstalled.
//
// The tests that matter here are about HONESTY of counting, not about plumbing:
// a safety number that inflates itself is worse than no number at all. So:
// refusals counted once per memory per event, recall events counted per event
// (never per candidate), an empty lookup is not a Déjà Fix win, a fresh install
// reports "no data" rather than a confident row of zeros, and the buckets stay
// bounded so this can never repeat the oplog's unbounded-history mistake.

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import {
  FIREWALL_STATS_SCHEMA_VERSION,
  recordFirewallActivity,
  summarizeFirewall,
  utcDay,
  type FirewallDay,
} from "../src/functions/firewall-stats.js";

let sdk: Kernel;
let kv: StateKV;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-fwstats" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});
afterEach(() => __resetKernelSingleton());

describe("firewall stats: honest counting", () => {
  it("reports a complete deterministic v2 schema with no data on a fresh install", async () => {
    expect(await summarizeFirewall(kv)).toEqual({
      schemaVersion: FIREWALL_STATS_SCHEMA_VERSION,
      days: 30,
      recalls: 0,
      refused: 0,
      injected: 0,
      served: {
        verified: 0,
        cosmetic: 0,
        sourced: 0,
        unsourced: 0,
        legacyUnclassified: 0,
      },
      dejafix: 0,
      hasData: false,
    });
  });

  it("accumulates one event's total and trust breakdown into today's v2 bucket", async () => {
    await recordFirewallActivity(kv, {
      recall: true,
      refused: 3,
      injected: 5,
      served: { verified: 1, cosmetic: 1, sourced: 2, unsourced: 1 },
    });
    const s = await summarizeFirewall(kv);
    expect(s.hasData).toBe(true);
    expect(s.recalls).toBe(1);
    expect(s.refused).toBe(3);
    expect(s.injected).toBe(5);
    expect(s.served).toEqual({
      verified: 1,
      cosmetic: 1,
      sourced: 2,
      unsourced: 1,
      legacyUnclassified: 0,
    });
    const rows = await kv.list<FirewallDay>(KV.firewallStats);
    expect(rows).toEqual([
      expect.objectContaining({
        schemaVersion: FIREWALL_STATS_SCHEMA_VERSION,
        injected: 5,
        served: s.served,
      }),
    ]);
  });

  it("counts recall EVENTS, not candidates", async () => {
    // Two recalls that between them refused 4 memories must read as 2 recalls,
    // not 4. Conflating them would let one busy query inflate the headline.
    await recordFirewallActivity(kv, { recall: true, refused: 1, injected: 2 });
    await recordFirewallActivity(kv, { recall: true, refused: 3, injected: 0 });
    const s = await summarizeFirewall(kv);
    expect(s.recalls).toBe(2);
    expect(s.refused).toBe(4);
  });

  it("does not count a recall event for a non-firewall write", async () => {
    // A Déjà Fix hit is not a recall event; it must not pad the recall count.
    await recordFirewallActivity(kv, { dejafix: 2 });
    const s = await summarizeFirewall(kv);
    expect(s.recalls).toBe(0);
    expect(s.dejafix).toBe(2);
  });

  it("keeps Déjà Fix and refusal accounting separate from served trust classes", async () => {
    await recordFirewallActivity(kv, {
      recall: true,
      refused: 2,
      injected: 1,
      served: { sourced: 1 },
    });
    await recordFirewallActivity(kv, { dejafix: 3 });
    const s = await summarizeFirewall(kv);
    expect(s).toMatchObject({
      recalls: 1,
      refused: 2,
      injected: 1,
      dejafix: 3,
      served: {
        verified: 0,
        cosmetic: 0,
        sourced: 1,
        unsourced: 0,
        legacyUnclassified: 0,
      },
    });
  });

  it("keeps separate daily buckets and sums them across the window", async () => {
    const now = Date.now();
    await recordFirewallActivity(kv, { recall: true, refused: 2 }, now - 2 * DAY);
    await recordFirewallActivity(kv, { recall: true, refused: 5 }, now);

    const rows = await kv.list<FirewallDay>(KV.firewallStats);
    expect(rows.length).toBe(2);

    const s = await summarizeFirewall(kv, 30, now);
    expect(s.refused).toBe(7);
    expect(s.recalls).toBe(2);
  });

  it("reads v1 aggregate-only buckets as legacy/unclassified, never verified", async () => {
    const now = Date.parse("2026-08-24T12:00:00Z");
    const date = utcDay(now);
    await kv.set(KV.firewallStats, date, {
      date,
      recalls: 2,
      refused: 3,
      injected: 7,
      dejafix: 1,
    });

    const legacy = await summarizeFirewall(kv, 30, now);
    expect(legacy).toMatchObject({
      schemaVersion: FIREWALL_STATS_SCHEMA_VERSION,
      recalls: 2,
      refused: 3,
      injected: 7,
      dejafix: 1,
      served: {
        verified: 0,
        cosmetic: 0,
        sourced: 0,
        unsourced: 0,
        legacyUnclassified: 7,
      },
    });

    // A later write on the same UTC day may upgrade the row shape, but it must
    // not rewrite unknowable history into a trusted class.
    await recordFirewallActivity(
      kv,
      { recall: true, injected: 1, served: { verified: 1 } },
      now,
    );
    const upgraded = await summarizeFirewall(kv, 30, now);
    expect(upgraded.injected).toBe(8);
    expect(upgraded.served).toEqual({
      verified: 1,
      cosmetic: 0,
      sourced: 0,
      unsourced: 0,
      legacyUnclassified: 7,
    });
    expect(await kv.get<FirewallDay>(KV.firewallStats, date)).toMatchObject({
      schemaVersion: FIREWALL_STATS_SCHEMA_VERSION,
      injected: 8,
      served: upgraded.served,
    });
  });

  it("treats a compatibility aggregate without labels as unclassified", async () => {
    await recordFirewallActivity(kv, { recall: true, injected: 2 });
    const s = await summarizeFirewall(kv);
    expect(s.injected).toBe(2);
    expect(s.served.verified).toBe(0);
    expect(s.served.legacyUnclassified).toBe(2);
  });

  it("excludes buckets outside the requested window", async () => {
    const now = Date.now();
    await recordFirewallActivity(kv, { recall: true, refused: 9 }, now - 20 * DAY);
    await recordFirewallActivity(kv, { recall: true, refused: 1 }, now);

    // A 7-day window must not silently include a 20-day-old bucket.
    const week = await summarizeFirewall(kv, 7, now);
    expect(week.refused).toBe(1);
    const month = await summarizeFirewall(kv, 30, now);
    expect(month.refused).toBe(10);
  });

  it("prunes by UTC date while retaining the inclusive 45-day cutoff", async () => {
    const now = Date.parse("2026-08-24T00:00:00Z");
    const cutoff = utcDay(now - 45 * DAY);
    const expired = utcDay(now - 45 * DAY - 1);
    for (const date of [cutoff, expired]) {
      await kv.set(KV.firewallStats, date, {
        date,
        recalls: 1,
        refused: 1,
        injected: 0,
        dejafix: 0,
      });
    }

    // Pruning happens on write — no timer to schedule, no unbounded growth.
    await recordFirewallActivity(kv, { recall: true, refused: 1 }, now);
    const rows = await kv.list<FirewallDay>(KV.firewallStats);
    expect(rows.map((r) => r.date).sort()).toEqual([cutoff, utcDay(now)]);
  });

  it("uses UTC dates rather than either caller offset's local date", async () => {
    // These instants have local calendar dates two days apart but both fall on
    // 2026-08-23 UTC. A local-date key would split one event into each date.
    const east = Date.parse("2026-08-24T00:30:00+14:00");
    const west = Date.parse("2026-08-22T23:30:00-12:00");
    await recordFirewallActivity(kv, { recall: true, refused: 1 }, east);
    await recordFirewallActivity(kv, { recall: true, refused: 1 }, west);
    const rows = await kv.list<FirewallDay>(KV.firewallStats);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-08-23", recalls: 2, refused: 2 });
  });
});

describe("firewall stats: recorded from a real recall", () => {
  it("a firewall-gated search records the event and what it served", async () => {
    const cwd = "/tmp/memwarden-fwstats-proj";
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "s1",
        project: cwd,
        cwd,
        timestamp: new Date().toISOString(),
        agent: "claude-code",
        data: {
          tool_name: "Edit",
          tool_input: { file_path: "src/a.ts" },
          tool_output: "postgres pool timeouts fixed by raising the limit",
        },
      },
    });

    await sdk.trigger({
      function_id: "mem::search",
      payload: { query: "postgres pool timeouts", cwd, safe_only: true },
    });

    const s = await summarizeFirewall(kv);
    expect(s.hasData).toBe(true);
    expect(s.recalls).toBeGreaterThanOrEqual(1);
  });

  it("a search with the firewall off records nothing", async () => {
    // Only firewall-gated recall is evidence of the firewall working. Counting
    // unguarded searches would overstate what it did.
    await sdk.trigger({
      function_id: "mem::search",
      payload: { query: "anything", safe_only: false },
    });
    expect((await summarizeFirewall(kv)).hasData).toBe(false);
  });
});
