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
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  applyUpdateOps,
  type MutationListener,
  type OplogCompactResult,
  type OplogEntry,
  type OplogEraseResult,
  type OplogOp,
  type StateEventType,
  type StateMutationEvent,
  type StateStore,
  type UpdateOp,
} from "./store.js";
import {
  GENESIS_PREV_HASH,
  buildEraseRecord,
  hashOplogEntryV2,
  hashPayload,
  planCompaction,
  pairKey,
  verifyChain,
} from "./oplog.js";

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
     hash TEXT NOT NULL,
     v INTEGER NOT NULL DEFAULT 1,
     payload_hash TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_oplog_scope ON oplog (scope, key)`,
];

// Chain-v2 columns for databases created before payload_hash existed. SQLite
// has no ADD COLUMN IF NOT EXISTS; each ALTER is tried and a "duplicate
// column" error means it is already applied.
const MIGRATIONS = [
  `ALTER TABLE oplog ADD COLUMN v INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE oplog ADD COLUMN payload_hash TEXT`,
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
        // Erased content must actually leave the file: secure_delete makes
        // SQLite zero freed bytes (old row images) instead of leaving them
        // in free page space. Best-effort — a build without it still erases
        // logically, and compact's VACUUM rewrites the whole file anyway.
        try {
          await this.client.execute(`PRAGMA secure_delete = ON`);
        } catch {
          // best-effort
        }
        for (const stmt of SCHEMA) {
          await this.client.execute(stmt);
        }
        for (const stmt of MIGRATIONS) {
          try {
            await this.client.execute(stmt);
          } catch (err) {
            // "duplicate column name" = already migrated; anything else is a
            // real schema failure and must surface.
            const msg = err instanceof Error ? err.message : String(err);
            if (!/duplicate column/i.test(msg)) throw err;
          }
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
      sql: `SELECT id, ts, op, scope, key, payload, prev_hash, hash, v, payload_hash
            FROM oplog WHERE id > ? ORDER BY id ASC`,
      args: [sinceId ?? 0],
    });
    return res.rows.map((row) => ({
      id: Number(row.id),
      ts: String(row.ts),
      op: String(row.op) as OplogOp,
      scope: String(row.scope),
      key: String(row.key),
      payload: row.payload === null ? null : decode<unknown>(row.payload),
      v: row.v === null || row.v === undefined ? 1 : Number(row.v),
      payload_hash: row.payload_hash === null || row.payload_hash === undefined
        ? null
        : String(row.payload_hash),
      prev_hash: String(row.prev_hash),
      hash: String(row.hash),
    }));
  }

  async verifyOplog(): Promise<{ ok: true } | { ok: false; brokenAt: number }> {
    const entries = await this.readOplog();
    const brokenAt = verifyChain(entries);
    return brokenAt === null ? { ok: true } : { ok: false, brokenAt };
  }

  async eraseOplogPayloads(scope: string, key: string): Promise<OplogEraseResult> {
    return this.serializeWrite(async () => {
      await this.init();
      // Refuse to touch the history of a LIVE record. Erasure is only for
      // records the user already deleted from the active store.
      const live = await this.client.execute({
        sql: `SELECT 1 FROM kv WHERE scope = ? AND key = ?`,
        args: [scope, key],
      });
      if (live.rows.length > 0) return { erased: 0, refused: "live-record" };

      // v1 rows hash over the RAW payload — nulling one breaks the chain.
      // All-or-none: if any payload-bearing v1 row exists, erase nothing and
      // point the caller at compact (which re-chains everything as v2).
      const v1 = await this.client.execute({
        sql: `SELECT COUNT(*) AS n FROM oplog
              WHERE scope = ? AND key = ? AND payload IS NOT NULL AND (v IS NULL OR v != 2)`,
        args: [scope, key],
      });
      const v1Count = Number(v1.rows[0]?.n ?? 0);
      if (v1Count > 0) return { erased: 0, refused: "v1-entries", v1Count };

      // Which rows are about to be nulled — their ids + payload_hashes go
      // into a chain-recorded `erase` entry so verifyChain can tell THIS
      // authorized erasure from an attacker silently nulling a payload.
      const targets = await this.client.execute({
        sql: `SELECT id, payload_hash FROM oplog
              WHERE scope = ? AND key = ? AND payload IS NOT NULL ORDER BY id ASC`,
        args: [scope, key],
      });
      if (targets.rows.length === 0) return { erased: 0 };
      const erased = targets.rows.map((r) => ({
        id: Number(r.id),
        payload_hash: String(r.payload_hash),
      }));

      const tail = await this.client.execute(
        `SELECT id, hash FROM oplog ORDER BY id DESC LIMIT 1`,
      );
      const tailRow = tail.rows[0]!; // targets exist, so the log is non-empty
      const rec = buildEraseRecord({
        id: Number(tailRow.id) + 1,
        ts: new Date().toISOString(),
        prev_hash: String(tailRow.hash),
        payload: { scope, key, erased },
      });

      // One batch = one transaction: the nulling and its authorization record
      // land together, or neither does — a crash can never leave the chain
      // with unauthorized (verification-breaking) nulls.
      await this.client.batch(
        [
          {
            sql: `UPDATE oplog SET payload = NULL
                  WHERE scope = ? AND key = ? AND payload IS NOT NULL`,
            args: [scope, key],
          },
          {
            sql: `INSERT INTO oplog (id, ts, op, scope, key, payload, prev_hash, hash, v, payload_hash)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
            args: [
              rec.id,
              rec.ts,
              rec.op,
              rec.scope,
              rec.key,
              encode(rec.payload),
              rec.prev_hash,
              rec.hash,
              rec.payload_hash,
            ],
          },
        ],
        "write",
      );
      // Flush the WAL so the erased bytes do not linger in the -wal file
      // (secure_delete handles the freed bytes inside the main db pages).
      await this.checkpointWal();
      return { erased: erased.length };
    });
  }

  async compactOplog(opts?: { dryRun?: boolean }): Promise<OplogCompactResult> {
    return this.serializeWrite(async () => {
      await this.init();
      const entries = await this.readOplog();
      // Belt-and-braces: the planner only erases delete-tailed pairs, and we
      // ADDITIONALLY require the kv row to be absent right now.
      const liveRows = await this.client.execute(`SELECT scope, key FROM kv`);
      const livePairs = new Set(
        liveRows.rows.map((r) => pairKey(String(r.scope), String(r.key))),
      );
      const compactedAt = new Date().toISOString();
      const plan = planCompaction(entries, livePairs, compactedAt);

      if (opts?.dryRun) {
        return {
          entriesRewritten: plan.entriesRewritten,
          erasedCount: plan.erasedCount,
          previousHeadHash: plan.previousHeadHash,
          compactedAt,
          dryRun: true,
          vacuum: { ok: false, bytesReclaimed: null, detail: "dry run — nothing written" },
        };
      }

      // Crash safety: ONE batch = one transaction. Either the whole rewrite
      // plus the anchoring compact record commits, or none of it does — a
      // crash mid-compact leaves the previous (still-verifying) chain
      // untouched. No temp-file swap is needed because SQLite's journal
      // already gives us the atomic all-or-nothing.
      const stmts: InStatement[] = [];
      for (let i = 0; i < entries.length; i++) {
        const before = entries[i]!;
        const after = plan.entries[i]!;
        if (
          before.v === after.v &&
          before.payload_hash === after.payload_hash &&
          before.prev_hash === after.prev_hash &&
          before.hash === after.hash &&
          (before.payload ?? null) === (after.payload ?? null)
        ) {
          continue; // byte-identical row — skip the write
        }
        stmts.push({
          sql: `UPDATE oplog SET payload = ?, v = 2, payload_hash = ?, prev_hash = ?, hash = ?
                WHERE id = ?`,
          args: [
            after.payload === null || after.payload === undefined
              ? null
              : encode(after.payload),
            after.payload_hash,
            after.prev_hash,
            after.hash,
            after.id,
          ],
        });
      }
      const rec = plan.compactRecord;
      stmts.push({
        sql: `INSERT INTO oplog (id, ts, op, scope, key, payload, prev_hash, hash, v, payload_hash)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
        args: [
          rec.id,
          rec.ts,
          rec.op,
          rec.scope,
          rec.key,
          encode(rec.payload),
          rec.prev_hash,
          rec.hash,
          rec.payload_hash,
        ],
      });
      await this.client.batch(stmts, "write");

      // Shrink: checkpoint the WAL (erased frames would otherwise survive in
      // the -wal file), then VACUUM to rewrite the db file without the freed
      // pages. VACUUM cannot run inside the transaction — it is atomic on
      // its own, so a crash here loses only the shrink, never the data.
      await this.checkpointWal();
      const sizeBefore = this.dbFileSize();
      let vacuum: OplogCompactResult["vacuum"];
      try {
        await this.client.execute(`VACUUM`);
        await this.checkpointWal();
        const sizeAfter = this.dbFileSize();
        vacuum = {
          ok: true,
          bytesReclaimed:
            sizeBefore !== null && sizeAfter !== null
              ? Math.max(0, sizeBefore - sizeAfter)
              : null,
        };
      } catch (err) {
        vacuum = {
          ok: false,
          bytesReclaimed: null,
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      return {
        entriesRewritten: plan.entriesRewritten,
        erasedCount: plan.erasedCount,
        previousHeadHash: plan.previousHeadHash,
        compactedAt,
        dryRun: false,
        vacuum,
      };
    });
  }

  /** Best-effort TRUNCATE checkpoint so erased payloads leave the -wal file. */
  private async checkpointWal(): Promise<void> {
    try {
      await this.client.execute(`PRAGMA wal_checkpoint(TRUNCATE)`);
    } catch {
      // best-effort (e.g. :memory: has no WAL)
    }
  }

  /** Current main db file size in bytes, or null when not file-backed. */
  private dbFileSize(): number | null {
    if (!this.dbPath) return null;
    try {
      return statSync(this.dbPath).size;
    } catch {
      return null;
    }
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

  /**
   * Build the hash-chained oplog INSERT statement for the next entry. New
   * entries are chain v2: the hash covers payload_hash (not the raw payload),
   * so a later erasure can null the payload in place without breaking the
   * chain.
   */
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
    const payload_hash = hashPayload(payload);
    const hash = hashOplogEntryV2({ id, ts, op, scope, key, payload_hash, prev_hash });
    return {
      sql: `INSERT INTO oplog (id, ts, op, scope, key, payload, prev_hash, hash, v, payload_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
      args: [
        id,
        ts,
        op,
        scope,
        key,
        payload === null ? null : encode(payload),
        prev_hash,
        hash,
        payload_hash,
      ],
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
