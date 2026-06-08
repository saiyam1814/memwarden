//
// A short-lived dedup set for the observe write path. Identical tool calls
// (same session + tool + input) seen again within a 5-minute window are
// suppressed, so a retried or replayed event is not stored twice. A periodic
// sweep clears expired keys; its timer is unref'd so it never holds the
// process open.

import { createHash } from "node:crypto";

const WINDOW_MS = 5 * 60 * 1000;
const SWEEP_MS = 60_000;
const MAX_INPUT = 500;

export class DedupMap {
  // hash -> expiry (epoch ms)
  private seen = new Map<string, number>();
  private sweep: ReturnType<typeof setInterval>;

  constructor() {
    this.sweep = setInterval(() => this.evictExpired(), SWEEP_MS);
    this.sweep.unref();
  }

  computeHash(sessionId: string, toolName: string, toolInput: unknown): string {
    const raw =
      typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput ?? "");
    return createHash("sha256")
      .update(`${sessionId}:${toolName}:${raw.slice(0, MAX_INPUT)}`)
      .digest("hex");
  }

  isDuplicate(hash: string): boolean {
    const expiry = this.seen.get(hash);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.seen.delete(hash);
      return false;
    }
    return true;
  }

  record(hash: string): void {
    this.seen.set(hash, Date.now() + WINDOW_MS);
  }

  stop(): void {
    clearInterval(this.sweep);
  }

  get size(): number {
    return this.seen.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [hash, expiry] of this.seen) {
      if (now > expiry) this.seen.delete(hash);
    }
  }
}
