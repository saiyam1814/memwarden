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
//   - `injected` counts memories that passed and were served.
// A refusal is counted once per memory per event, never once per scan pass.
//
// Bounded by construction: buckets older than the retention window are pruned
// on write, so this can never become the kind of unbounded history that made
// the oplog 95% of the database.

import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "./logger.js";

/** Daily buckets are kept for this long; older ones are pruned on write. */
const RETAIN_DAYS = 45;

export interface FirewallDay {
  /** UTC date, YYYY-MM-DD. Doubles as the KV key. */
  date: string;
  recalls: number;
  refused: number;
  injected: number;
  /** Déjà Fix hits served — a verified prior fix surfacing in a new session. */
  dejafix: number;
}

export interface FirewallActivity {
  refused?: number;
  injected?: number;
  dejafix?: number;
  /** Counts this as one firewall-gated recall event. */
  recall?: boolean;
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
    const existing = await kv.get<FirewallDay>(KV.firewallStats, date);
    const row: FirewallDay = {
      date,
      recalls: (existing?.recalls ?? 0) + (activity.recall ? 1 : 0),
      refused: (existing?.refused ?? 0) + (activity.refused ?? 0),
      injected: (existing?.injected ?? 0) + (activity.injected ?? 0),
      dejafix: (existing?.dejafix ?? 0) + (activity.dejafix ?? 0),
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
  /** Totals over the requested window. */
  days: number;
  recalls: number;
  refused: number;
  injected: number;
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
    days: windowDays,
    recalls: 0,
    refused: 0,
    injected: 0,
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
  const from = utcDay(now - Math.max(0, windowDays - 1) * 24 * 60 * 60 * 1000);
  const inWindow = all.filter(
    (d) => typeof d?.date === "string" && d.date >= from,
  );
  if (inWindow.length === 0) return { ...empty, hasData: all.length > 0 };
  return {
    days: windowDays,
    recalls: inWindow.reduce((n, d) => n + (d.recalls ?? 0), 0),
    refused: inWindow.reduce((n, d) => n + (d.refused ?? 0), 0),
    injected: inWindow.reduce((n, d) => n + (d.injected ?? 0), 0),
    dejafix: inWindow.reduce((n, d) => n + (d.dejafix ?? 0), 0),
    hasData: true,
  };
}
