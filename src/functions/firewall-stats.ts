//
// What the firewall actually did — the evidence surface.
//
// A firewall that works silently is indistinguishable from one that does
// nothing. memwarden blocked stale memory for six weeks on the maintainer's own
// machine and never once said so, which is the same reason the "0 memories" bug
// survived: numbers nobody surfaces are numbers nobody checks. Invisible value
// also churns — a set-and-forget tool whose benefit is never shown gets
// uninstalled during the next disk cleanup.
//
// So every recall that runs the firewall records what it decided, in daily
// buckets. Honest counting rules, because inflated safety numbers are worse
// than none:
//   - `recalls` counts recall EVENTS that ran the firewall, not candidates.
//   - `refused` counts memories actually withheld from the model.
//   - `injected` remains the compatibility total for memories actually served.
//   - `served` splits that total by the trust label attached at return time.
// Served/refused memories are counted once per memory per event, never once per
// scan pass. Packing happens before served activity is recorded, so a selected
// result that misses the token budget cannot inflate the evidence surface.
//
// Bounded by construction: buckets older than the retention window are pruned
// on write, so this can never become the kind of unbounded history that made
// the oplog 95% of the database.

import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "./logger.js";

/** Daily buckets are kept for this long; older ones are pruned on write. */
const RETAIN_DAYS = 45;

/**
 * Version 1 was the unversioned aggregate-only shape shipped in 0.1.0. Version
 * 2 adds an explicit trust breakdown. The public summary is always emitted as
 * the complete v2 shape, including zero-valued fields, for deterministic JSON.
 */
export const FIREWALL_STATS_SCHEMA_VERSION = 2 as const;

export interface FirewallServed {
  verified: number;
  cosmetic: number;
  sourced: number;
  unsourced: number;
  /** Counts v1 aggregate values whose original trust is unknowable. */
  legacyUnclassified: number;
}

/**
 * Persisted daily row. `schemaVersion` and `served` remain optional in this
 * read type because v1 rows had neither. Every new write emits both as v2.
 */
export interface FirewallDay {
  schemaVersion?: number;
  /** UTC date, YYYY-MM-DD. Doubles as the KV key. */
  date: string;
  recalls: number;
  refused: number;
  /** Compatibility total; equals the sum of every `served` class in v2. */
  injected: number;
  served?: Partial<FirewallServed>;
  /** Déjà Fix hits served — a verified prior fix surfacing in a new session. */
  dejafix: number;
}

export interface FirewallActivity {
  refused?: number;
  /** Compatibility total. A total without `served` is unclassified, never
   * verified. */
  injected?: number;
  /** Trust labels of memories returned by this event after token packing. */
  served?: Partial<FirewallServed>;
  dejafix?: number;
  /** Counts this as one firewall-gated recall event. */
  recall?: boolean;
}

interface NormalizedFirewallDay {
  date: string;
  recalls: number;
  refused: number;
  injected: number;
  served: FirewallServed;
  dejafix: number;
}

function emptyServed(): FirewallServed {
  return {
    verified: 0,
    cosmetic: 0,
    sourced: 0,
    unsourced: 0,
    legacyUnclassified: 0,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function servedTotal(served: FirewallServed): number {
  return (
    served.verified +
    served.cosmetic +
    served.sourced +
    served.unsourced +
    served.legacyUnclassified
  );
}

function normalizeServed(
  value: Partial<FirewallServed> | undefined,
): FirewallServed {
  return {
    verified: count(value?.verified),
    cosmetic: count(value?.cosmetic),
    sourced: count(value?.sourced),
    unsourced: count(value?.unsourced),
    legacyUnclassified: count(value?.legacyUnclassified),
  };
}

/**
 * Read either persisted generation conservatively. A v1 total has no evidence
 * from which to recover trust, so all of it is legacy/unclassified. A partial
 * v2 breakdown puts any aggregate remainder there for the same reason.
 */
function normalizeDay(day: FirewallDay): NormalizedFirewallDay {
  const aggregate = count(day.injected);
  let served: FirewallServed;
  if (day.schemaVersion === FIREWALL_STATS_SCHEMA_VERSION && day.served) {
    served = normalizeServed(day.served);
    const classified = servedTotal(served);
    served.legacyUnclassified += Math.max(0, aggregate - classified);
  } else {
    served = emptyServed();
    served.legacyUnclassified = aggregate;
  }
  return {
    date: typeof day.date === "string" ? day.date : "",
    recalls: count(day.recalls),
    refused: count(day.refused),
    injected: Math.max(aggregate, servedTotal(served)),
    served,
    dejafix: count(day.dejafix),
  };
}

/** Normalize one new activity while preserving aggregate-only callers safely. */
function normalizeActivity(activity: FirewallActivity): Pick<
  NormalizedFirewallDay,
  "refused" | "injected" | "served" | "dejafix"
> {
  const served = normalizeServed(activity.served);
  const classified = servedTotal(served);
  const aggregate =
    activity.injected === undefined
      ? classified
      : Math.max(count(activity.injected), classified);
  served.legacyUnclassified += aggregate - classified;
  return {
    refused: count(activity.refused),
    injected: aggregate,
    served,
    dejafix: count(activity.dejafix),
  };
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Add one event's outcome to today's bucket. Best-effort by contract: the
 * caller is on the recall hot path, and a stats write must never be able to
 * fail a recall or slow it perceptibly.
 */
export async function recordFirewallActivity(
  kv: StateKV,
  activity: FirewallActivity,
  now = Date.now(),
): Promise<void> {
  const date = utcDay(now);
  try {
    const stored = await kv.get<FirewallDay>(KV.firewallStats, date);
    const existing = stored
      ? normalizeDay(stored)
      : {
          date,
          recalls: 0,
          refused: 0,
          injected: 0,
          served: emptyServed(),
          dejafix: 0,
        };
    const added = normalizeActivity(activity);
    const row: FirewallDay = {
      schemaVersion: FIREWALL_STATS_SCHEMA_VERSION,
      date,
      recalls: existing.recalls + (activity.recall ? 1 : 0),
      refused: existing.refused + added.refused,
      injected: existing.injected + added.injected,
      served: {
        verified: existing.served.verified + added.served.verified,
        cosmetic: existing.served.cosmetic + added.served.cosmetic,
        sourced: existing.served.sourced + added.served.sourced,
        unsourced: existing.served.unsourced + added.served.unsourced,
        legacyUnclassified:
          existing.served.legacyUnclassified + added.served.legacyUnclassified,
      },
      dejafix: existing.dejafix + added.dejafix,
    };
    await kv.set(KV.firewallStats, date, row);
  } catch (err) {
    logger.warn("firewall stats update failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Prune on write rather than on a timer: no scheduling, and the cost is one
  // list of at most ~45 tiny rows.
  try {
    const cutoff = utcDay(now - RETAIN_DAYS * 24 * 60 * 60 * 1000);
    const all = await kv.list<FirewallDay>(KV.firewallStats);
    for (const d of all) {
      if (typeof d?.date === "string" && d.date < cutoff) {
        await kv.delete(KV.firewallStats, d.date);
      }
    }
  } catch {
    // pruning is maintenance, never worth surfacing
  }
}

export interface FirewallSummary {
  /** Versioned contract shared by /stats and status --json. */
  schemaVersion: typeof FIREWALL_STATS_SCHEMA_VERSION;
  /** Totals over the requested window. */
  days: number;
  recalls: number;
  refused: number;
  /** Compatibility total; always equals the sum of `served`. */
  injected: number;
  /** Deterministic trust breakdown; every key is present even when zero. */
  served: FirewallServed;
  dejafix: number;
  /** Whether any bucket exists at all — lets callers stay silent on a fresh
   *  install rather than reporting a confident-looking row of zeros. */
  hasData: boolean;
}

/** Totals over the last `windowDays` UTC days, inclusive of today. */
export async function summarizeFirewall(
  kv: StateKV,
  windowDays = 30,
  now = Date.now(),
): Promise<FirewallSummary> {
  const empty: FirewallSummary = {
    schemaVersion: FIREWALL_STATS_SCHEMA_VERSION,
    days: windowDays,
    recalls: 0,
    refused: 0,
    injected: 0,
    served: emptyServed(),
    dejafix: 0,
    hasData: false,
  };
  let all: FirewallDay[];
  try {
    all = await kv.list<FirewallDay>(KV.firewallStats);
  } catch {
    return empty;
  }
  // windowDays - 1 because the window includes today.
  const from = utcDay(
    now - Math.max(0, windowDays - 1) * 24 * 60 * 60 * 1000,
  );
  const inWindow = all
    .filter((d) => typeof d?.date === "string" && d.date >= from)
    .map(normalizeDay);
  if (inWindow.length === 0) return { ...empty, hasData: all.length > 0 };
  const served = inWindow.reduce<FirewallServed>(
    (total, day) => ({
      verified: total.verified + day.served.verified,
      cosmetic: total.cosmetic + day.served.cosmetic,
      sourced: total.sourced + day.served.sourced,
      unsourced: total.unsourced + day.served.unsourced,
      legacyUnclassified:
        total.legacyUnclassified + day.served.legacyUnclassified,
    }),
    emptyServed(),
  );
  return {
    schemaVersion: FIREWALL_STATS_SCHEMA_VERSION,
    days: windowDays,
    recalls: inWindow.reduce((n, d) => n + d.recalls, 0),
    refused: inWindow.reduce((n, d) => n + d.refused, 0),
    injected: servedTotal(served),
    served,
    dejafix: inWindow.reduce((n, d) => n + d.dejafix, 0),
    hasData: true,
  };
}
