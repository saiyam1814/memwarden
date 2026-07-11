//
// libSQL-backed StateStore. Replaces the original file-based KV
// (./data/state_store.db, opaque blob) with a real relational store that
// gives `list(scope)` an exact index lookup instead of an O(N) scan, while
// preserving every observable StateKV semantic.
//
// Schema (one co-located file, `file:...` or `:memory:`):
// kv(scope TEXT, key TEXT, value TEXT JSON, created_at, updated_at,
// PRIMARY KEY (scope, key))            -- index on scope for list()
// oplog(id INTEGER PK AUTOINCREMENT, ts, op, scope, key,
// payload TEXT JSON, prev_hash, hash)
//
// Writes (set/update/delete) read the current value + oplog tail, then commit
// the `kv` change AND the matching `oplog` row as a SINGLE atomic batch, so the
// hash chain and the data can never diverge. We use `batch` rather than an
// interactive transaction because the libSQL local driver opens a separate
// connection per interactive transaction, and a `:memory:` database is
// per-connection (the transaction would not see the schema/data). All writes
// are serialized through an in-process promise chain: the read-then-batch pair
// must be atomic with respect to other writes because `prev_hash` depends on
// the previous committed entry. This is correct only for a single-process
// kernel; a multi-process memwarden would need a real lock (the same caveat
// as withKeyedLock).

import { createClient, type Client, type InStatement } from "@libsql/client";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  applyUpdateOps,
  type MutationListener,
  type OplogEntry,
  type StateEventType,
  type StateMutationEvent,
  type StateStore,
  type UpdateOp,
} from "./store.js";
import { GENESIS_PREV_HASH, hashOplogEntry, verifyChain } from "./oplog.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (
     scope TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (scope, key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv (scope)`,
  `CREATE TABLE IF NOT EXISTS oplog (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     op TEXT NOT NULL,
     scope TEXT NOT NULL,
     key TEXT NOT NULL,
     payload TEXT,
     prev_hash TEXT NOT NULL,
     hash TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_oplog_scope ON oplog (scope, key)`,
];

export interface StoreLibsqlOptions {
  /** libSQL URL: `file:/path/to/mem.db` or `:memory:`. */
  url: string;
  /** Optional auth token (for remote libSQL/Turso; unused for local files). */
  authToken?: string;
}

export class StoreLibsql implements StateStore {
  private readonly client: Client;
  private readonly listeners = new Set<MutationListener>();
  /** Serializes writes so the oplog prev_hash read+append is atomic per-process. */
  private writeChain: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | null = null;
  private closed = false;
  /** Local db path (file: URL) so init() can tighten its mode post-create. */
  private readonly dbPath: string | null = null;

  constructor(options: StoreLibsqlOptions) {
    // For a local `file:` URL, ensure the parent directory exists first.
    // libSQL/SQLite does NOT create missing directories and fails with
    // SQLITE_CANTOPEN — so a first run against a fresh data dir would crash
    // on boot. Create it here so every caller (daemon, tests, tools) is safe.
    const fileMatch = /^file:(.+)$/.exec(options.url);
    if (fileMatch) {
      this.dbPath = fileMatch[1] as string;
      const dir = dirname(this.dbPath);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // best-effort; createClient below surfaces a real open error
      }
      // The brain is private data: owner-only directory (default is 0755).
      // Best-effort — some filesystems reject chmod; the data still writes.
      try {
        chmodSync(dir, 0o700);
      } catch {
        // best-effort
      }
    }
    this.client = createClient(
      options.authToken === undefined
        ? { url: options.url }
        : { url: options.url, authToken: options.authToken },
    );
  }

  /** Idempotently apply the schema. Awaited by every public method. */
  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        for (const stmt of SCHEMA) {
          await this.client.execute(stmt);
        }
        // The db file exists after the first execute; tighten it from the
        // default 0644 (memories are private data). Best-effort.
        if (this.dbPath) {
          try {
            chmodSync(this.dbPath, 0o600);
          } catch {
            // best-effort
          }
        }
      })();
    }
    return this.ready;
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    await this.init();
    const res = await this.client.execute({
      sql: `SELECT value FROM kv WHERE scope = ? AND key = ?`,
      args: [scope, key],
    });
    const row = res.rows[0];
    if (!row) return null;
    return decode<T>(row.value);
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    await this.init();
    // Insertion order: rowid is monotonic with insert order, and an upsert
    // updates value in place without changing rowid, so ordering by rowid
    // reproduces Map insertion-order semantics.
    const res = await this.client.execute({
      sql: `SELECT value FROM kv WHERE scope = ? ORDER BY rowid ASC`,
      args: [scope],
    });
    return res.rows.map((row) => decode<T>(row.value));
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    await this.serializeWrite(async () => {
      // set always produces an event (never the delete-no-op null).
      const event = await this.writeTx("set", scope, key, value);
      if (event) this.emit(event);
    });
    return value;
  }

  async update<T = unknown>(scope: string, key: string, ops: readonly UpdateOp[]): Promise<T> {
    let updated: Record<string, unknown> = {};
    await this.serializeWrite(async () => {
      // update always produces an event (never the delete-no-op null).
      const event = await this.writeTx("update", scope, key, undefined, ops);
      if (event) {
        updated = event.new_value as Record<string, unknown>;
        this.emit(event);
      }
    });
    return updated as T;
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.serializeWrite(async () => {
      const event = await this.writeTx("delete", scope, key, undefined);
      // Only emit/log if the row actually existed (event is null otherwise).
      if (event) this.emit(event);
    });
  }

  onMutation(listener: MutationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async readOplog(sinceId?: number): Promise<OplogEntry[]> {
    await this.init();
    const res = await this.client.execute({
      sql: `SELECT id, ts, op, scope, key, payload, prev_hash, hash
            FROM oplog WHERE id > ? ORDER BY id ASC`,
      args: [sinceId ?? 0],
    });
    return res.rows.map((row) => ({
      id: Number(row.id),
      ts: String(row.ts),
      op: String(row.op) as StateEventType,
      scope: String(row.scope),
      key: String(row.key),
      payload: row.payload === null ? null : decode<unknown>(row.payload),
      prev_hash: String(row.prev_hash),
      hash: String(row.hash),
    }));
  }

  async verifyOplog(): Promise<{ ok: true } | { ok: false; brokenAt: number }> {
    const entries = await this.readOplog();
    const brokenAt = verifyChain(entries);
    return brokenAt === null ? { ok: true } : { ok: false, brokenAt };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Drain in-flight writes before closing the client.
    await this.writeChain.catch(() => undefined);
    this.listeners.clear();
    this.client.close();
  }

  /**
   * Perform one mutation + its matching oplog append as a single atomic batch.
   * Reads the current value (for old_value / the update base) and the oplog
   * tail (for prev_hash) first; serialization via the write chain guarantees no
   * other write interleaves between the reads and the batch commit. Returns the
   * mutation event to emit, or null for a delete that hit nothing (idempotent
   * no-op, no oplog row).
   */
  private async writeTx(
    op: StateEventType,
    scope: string,
    key: string,
    value: unknown,
    ops?: readonly UpdateOp[],
  ): Promise<StateMutationEvent | null> {
    await this.init();

    const cur = await this.client.execute({
      sql: `SELECT value FROM kv WHERE scope = ? AND key = ?`,
      args: [scope, key],
    });
    const existingRow = cur.rows[0];
    const oldValue = existingRow ? decode<unknown>(existingRow.value) : undefined;

    let newValue: unknown;
    let mutation: InStatement;
    let event: StateMutationEvent;

    if (op === "delete") {
      if (!existingRow) return null;
      newValue = null;
      mutation = {
        sql: `DELETE FROM kv WHERE scope = ? AND key = ?`,
        args: [scope, key],
      };
      event = {
        scope,
        key,
        event_type: "delete",
        ...(oldValue === undefined ? {} : { old_value: oldValue }),
      };
    } else {
      if (op === "update") {
        const base =
          oldValue && typeof oldValue === "object" && !Array.isArray(oldValue)
            ? (oldValue as Record<string, unknown>)
            : {};
        newValue = applyUpdateOps({ ...base }, ops ?? []);
      } else {
        newValue = value;
      }
      const now = new Date().toISOString();
      mutation = {
        sql: `INSERT INTO kv (scope, key, value, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(scope, key)
              DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [scope, key, encode(newValue), now, now],
      };
      event = {
        scope,
        key,
        event_type: op,
        ...(oldValue === undefined ? {} : { old_value: oldValue }),
        new_value: newValue,
      };
    }

    const oplogStmt = await this.buildOplogInsert(op, scope, key, newValue);
    await this.client.batch([mutation, oplogStmt], "write");
    return event;
  }

  /** Build the hash-chained oplog INSERT statement for the next entry. */
  private async buildOplogInsert(
    op: StateEventType,
    scope: string,
    key: string,
    payload: unknown,
  ): Promise<InStatement> {
    const tail = await this.client.execute(
      `SELECT id, hash FROM oplog ORDER BY id DESC LIMIT 1`,
    );
    const tailRow = tail.rows[0];
    const id = tailRow ? Number(tailRow.id) + 1 : 1;
    const prev_hash = tailRow ? String(tailRow.hash) : GENESIS_PREV_HASH;
    const ts = new Date().toISOString();
    const hash = hashOplogEntry({ id, ts, op, scope, key, payload, prev_hash });
    return {
      sql: `INSERT INTO oplog (id, ts, op, scope, key, payload, prev_hash, hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, ts, op, scope, key, payload === null ? null : encode(payload), prev_hash, hash],
    };
  }

  /** Chain writes so prev_hash reads never race a concurrent append. */
  private serializeWrite<R>(work: () => Promise<R>): Promise<R> {
    const next = this.writeChain.then(work, work);
    // Keep the chain alive even if `work` rejects, without swallowing the
    // rejection that the caller awaits.
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private emit(event: StateMutationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listeners must not break the write path.
      }
    }
  }
}

function encode(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function decode<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}
