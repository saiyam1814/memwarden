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
  it("reports no data on a fresh install rather than a confident row of zeros", async () => {
    const s = await summarizeFirewall(kv);
    expect(s.hasData).toBe(false);
    expect(s.refused).toBe(0);
    expect(s.injected).toBe(0);
  });

  it("accumulates one event's outcome into today's bucket", async () => {
    await recordFirewallActivity(kv, { recall: true, refused: 3, injected: 5 });
    const s = await summarizeFirewall(kv);
    expect(s.hasData).toBe(true);
    expect(s.recalls).toBe(1);
    expect(s.refused).toBe(3);
    expect(s.injected).toBe(5);
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

  it("prunes buckets past the retention window so history stays bounded", async () => {
    const now = Date.now();
    // Older than the 45-day retention window.
    await recordFirewallActivity(kv, { recall: true, refused: 4 }, now - 60 * DAY);
    expect((await kv.list(KV.firewallStats)).length).toBe(1);

    // Pruning happens on write — no timer to schedule, no unbounded growth.
    await recordFirewallActivity(kv, { recall: true, refused: 1 }, now);
    const rows = await kv.list<FirewallDay>(KV.firewallStats);
    expect(rows.map((r) => r.date)).toEqual([utcDay(now)]);
  });

  it("uses UTC dates so a bucket cannot split on the caller's timezone", async () => {
    // Two writes seconds apart across a local-midnight boundary must land in
    // the same UTC bucket; keying on local time would double-count them.
    const utcNoon = Date.parse("2026-08-24T12:00:00Z");
    await recordFirewallActivity(kv, { recall: true, refused: 1 }, utcNoon);
    await recordFirewallActivity(kv, { recall: true, refused: 1 }, utcNoon + 1000);
    const rows = await kv.list<FirewallDay>(KV.firewallStats);
    expect(rows.length).toBe(1);
    expect(rows[0]!.date).toBe("2026-08-24");
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
