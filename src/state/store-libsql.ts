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

import { createClient, type Client, type InStatement, type Row } from "@libsql/client";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  applyUpdateOps,
  type MutationListener,
  type OplogCompactOptions,
  type OplogCompactResult,
  type OplogEntry,
  type OplogEntryRef,
  type OplogEraseResult,
  type OplogVerifyOptions,
  type OplogOp,
  type StateEventType,
  type StateMutationEvent,
  type StateStore,
  type UpdateOp,
} from "./store.js";
import {
  ChainVerifier,
  CompactionPlanner,
  GENESIS_PREV_HASH,
  buildCompactionIndex,
  buildEraseRecord,
  collectEraseAuthorizations,
  hashOplogEntryV2,
  hashPayload,
  pairKey,
} from "./oplog.js";

/**
 * Rows per page when walking the oplog. Chain verification and compaction
 * hold one page of decoded payloads at a time, so memory stays bounded by the
 * page (plus a few oversized rows), never by the length of history.
 */
const OPLOG_PAGE = 500;

const OPLOG_COLUMNS = `id, ts, op, scope, key, payload, prev_hash, hash, v, payload_hash`;

/** How long a full verification may be extended by incremental ones. */
const VERIFY_REUSE_MS = 60_000;

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
  /**
   * Bumped whenever history is rewritten in place (erase, compact). A paged
   * verification that races one of those can read half of each version; it
   * compares epochs and re-runs instead of reporting a false break.
   */
  private oplogEpoch = 0;
  /**
   * The newest entry covered by the last successful FULL verification, when
   * it ran, and the epoch it ran under. Incremental verification continues
   * the chain from here instead of re-walking all of history.
   */
  private verifiedThrough: { id: number; hash: string; at: number; epoch: number } | null =
    null;

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
      sql: `SELECT ${OPLOG_COLUMNS} FROM oplog WHERE id > ? ORDER BY id ASC`,
      args: [sinceId ?? 0],
    });
    return res.rows.map(rowToEntry);
  }

  /** id/op/scope/key for every entry, paged, without touching payloads. */
  private async readOplogIndexRows(): Promise<
    Array<Pick<OplogEntry, "id" | "op" | "scope" | "key">>
  > {
    const rows: Array<Pick<OplogEntry, "id" | "op" | "scope" | "key">> = [];
    let after = 0;
    for (;;) {
      const page = await this.client.execute({
        sql: `SELECT id, op, scope, key FROM oplog WHERE id > ? ORDER BY id ASC LIMIT ?`,
        args: [after, OPLOG_PAGE * 20],
      });
      for (const row of page.rows) {
        after = Number(row.id);
        rows.push({
          id: after,
          op: String(row.op) as OplogOp,
          scope: String(row.scope),
          key: String(row.key),
        });
      }
      if (page.rows.length < OPLOG_PAGE * 20) return rows;
    }
  }

  /** Walk the oplog in id order one page at a time (payloads decoded per page). */
  private async *iterateOplog(): AsyncGenerator<OplogEntry> {
    await this.init();
    let after = 0;
    for (;;) {
      const page = await this.client.execute({
        sql: `SELECT ${OPLOG_COLUMNS} FROM oplog WHERE id > ? ORDER BY id ASC LIMIT ?`,
        args: [after, OPLOG_PAGE],
      });
      if (page.rows.length === 0) return;
      for (const row of page.rows) {
        const entry = rowToEntry(row);
        after = entry.id;
        yield entry;
      }
      if (page.rows.length < OPLOG_PAGE) return;
    }
  }

  async oplogCount(): Promise<number> {
    await this.init();
    const res = await this.client.execute(`SELECT COUNT(*) AS n FROM oplog`);
    return Number(res.rows[0]?.n ?? 0);
  }

  async oplogHead(): Promise<{ id: number; hash: string } | null> {
    await this.init();
    const res = await this.client.execute(
      `SELECT id, hash FROM oplog ORDER BY id DESC LIMIT 1`,
    );
    const row = res.rows[0];
    return row ? { id: Number(row.id), hash: String(row.hash) } : null;
  }

  async findOplogEntries(key: string, scope?: string): Promise<OplogEntryRef[]> {
    await this.init();
    const res = await this.client.execute(
      scope === undefined
        ? {
            sql: `SELECT id, ts, op, scope, key, hash, prev_hash FROM oplog
                  WHERE key = ? ORDER BY id ASC`,
            args: [key],
          }
        : {
            sql: `SELECT id, ts, op, scope, key, hash, prev_hash FROM oplog
                  WHERE scope = ? AND key = ? ORDER BY id ASC`,
            args: [scope, key],
          },
    );
    return res.rows.map((row) => ({
      id: Number(row.id),
      ts: String(row.ts),
      op: String(row.op) as OplogOp,
      scope: String(row.scope),
      key: String(row.key),
      hash: String(row.hash),
      prev_hash: String(row.prev_hash),
    }));
  }

  async verifyOplog(
    opts?: OplogVerifyOptions,
  ): Promise<{ ok: true } | { ok: false; brokenAt: number }> {
    if (opts?.incremental) {
      const tail = await this.verifyAppendedSince();
      if (tail !== undefined) {
        return tail === null ? { ok: true } : { ok: false, brokenAt: tail };
      }
    }
    // Paged, so verification memory is bounded by a page rather than by the
    // log. The single-SELECT version read (and JSON-decoded) every payload in
    // history at once; on a month-old brain that is gigabytes and exhausts
    // the daemon's heap. Reads are not one snapshot, so a break observed
    // while an erase/compact rewrote history is re-checked, not reported.
    for (let attempt = 0; ; attempt++) {
      const epoch = this.oplogEpoch;
      const startedAt = Date.now();
      const result = await this.verifyOplogOnce();
      if (result.brokenAt === null) {
        this.verifiedThrough =
          this.oplogEpoch === epoch && result.through
            ? { ...result.through, at: startedAt, epoch }
            : null;
        return { ok: true };
      }
      this.verifiedThrough = null;
      if (this.oplogEpoch === epoch || attempt >= 2) {
        return { ok: false, brokenAt: result.brokenAt };
      }
    }
  }

  /**
   * Continue the last full verification over the entries appended since.
   * Returns undefined when that is not safe and a full walk is required:
   * no recent full verification, history rewritten in place since (erase,
   * compact), or an erase/compact record in the tail — those authorize
   * earlier nulls, which only a full walk can re-judge. Only appends are
   * trusted to the incremental path, and only for VERIFY_REUSE_MS after a
   * full walk, so a change to already-verified rows is caught by the next
   * full verification within that window.
   */
  private async verifyAppendedSince(): Promise<number | null | undefined> {
    const base = this.verifiedThrough;
    if (
      !base ||
      base.epoch !== this.oplogEpoch ||
      Date.now() - base.at > VERIFY_REUSE_MS
    ) {
      return undefined;
    }
    await this.init();
    const tail = await this.client.execute({
      sql: `SELECT ${OPLOG_COLUMNS} FROM oplog WHERE id > ? ORDER BY id ASC`,
      args: [base.id],
    });
    const entries = tail.rows.map(rowToEntry);
    if (entries.some((e) => e.op === "erase" || e.op === "compact")) return undefined;
    // The anchor row itself must still be the one we verified: a rewritten
    // or deleted anchor means history changed underneath the cached result.
    const anchor = await this.client.execute({
      sql: `SELECT hash FROM oplog WHERE id = ?`,
      args: [base.id],
    });
    if (String(anchor.rows[0]?.hash ?? "") !== base.hash) return undefined;
    const verifier = new ChainVerifier(new Map(), base);
    for (const entry of entries) {
      const brokenAt = verifier.push(entry);
      if (brokenAt !== null) {
        this.verifiedThrough = null;
        return brokenAt;
      }
    }
    const last = entries.at(-1);
    if (last && base.epoch === this.oplogEpoch) {
      this.verifiedThrough = { ...base, id: last.id, hash: last.hash };
    }
    return null;
  }

  private async verifyOplogOnce(): Promise<{
    brokenAt: number | null;
    through: { id: number; hash: string } | null;
  }> {
    await this.init();
    // Authorizations first: a null payload is only legitimate when a LATER
    // erase/compact record vouches for it, so those (few) rows are needed
    // before the walk reaches the entries they authorize.
    const anchors = await this.client.execute(
      `SELECT ${OPLOG_COLUMNS} FROM oplog WHERE op IN ('erase', 'compact') ORDER BY id ASC`,
    );
    const verifier = new ChainVerifier(
      collectEraseAuthorizations(anchors.rows.map(rowToEntry)),
    );
    let through: { id: number; hash: string } | null = null;
    for await (const entry of this.iterateOplog()) {
      const brokenAt = verifier.push(entry);
      if (brokenAt !== null) return { brokenAt, through: null };
      through = { id: entry.id, hash: entry.hash };
    }
    return { brokenAt: null, through };
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
      this.oplogEpoch++;
      // Flush the WAL so the erased bytes do not linger in the -wal file
      // (secure_delete handles the freed bytes inside the main db pages).
      await this.checkpointWal();
      return { erased: erased.length };
    });
  }

  async compactOplog(opts?: OplogCompactOptions): Promise<OplogCompactResult> {
    return this.serializeWrite(async () => {
      await this.init();
      // Pass 1 — the per-key index, from id/op/scope/key only. No payload is
      // read, so this stays small however long history grows.
      const index = buildCompactionIndex(await this.readOplogIndexRows());
      // Belt-and-braces: the planner only erases delete-tailed pairs, and we
      // ADDITIONALLY require the kv row to be absent right now.
      const liveRows = await this.client.execute(`SELECT scope, key FROM kv`);
      const livePairs = new Set(
        liveRows.rows.map((r) => pairKey(String(r.scope), String(r.key))),
      );
      const compactedAt = new Date().toISOString();
      // Same planner, same options as StoreMemory (parity by construction),
      // fed one page at a time: the pre-streaming version decoded the entire
      // oplog up front, which on a mature brain is gigabytes of payloads and
      // exhausted the daemon's heap on the very command meant to shrink it.
      const planner = new CompactionPlanner(index, livePairs, opts);

      // Crash safety: ONE batch = one transaction. Either the whole rewrite
      // plus the anchoring compact record commits, or none of it does — a
      // crash mid-compact leaves the previous (still-verifying) chain
      // untouched. No temp-file swap is needed because SQLite's journal
      // already gives us the atomic all-or-nothing.
      const stmts: InStatement[] = [];
      // Rows where the ONLY change is the payload going away (already v2, so
      // every hash column stays byte-identical) are nulled in id batches
      // instead of one statement each: a pruning compaction touches most of a
      // mature oplog, and 100k+ single-row statements in one batch is not a
      // shape worth handing the driver.
      const nullOnly: number[] = [];
      for await (const before of this.iterateOplog()) {
        const after = planner.feed(before);
        if (opts?.dryRun) continue;
        const nulled = after.payload === null || after.payload === undefined;
        const sameColumns =
          before.v === after.v &&
          before.payload_hash === after.payload_hash &&
          before.prev_hash === after.prev_hash &&
          before.hash === after.hash;
        if (sameColumns && (before.payload ?? null) === (after.payload ?? null)) {
          continue; // byte-identical row — skip the write
        }
        if (sameColumns && before.v === 2 && nulled) {
          nullOnly.push(after.id);
          continue;
        }
        // The planner only ever keeps a payload verbatim or nulls it, so the
        // payload column is either left alone or set NULL. Statements never
        // carry payload text, which keeps a v1 -> v2 migration of a large log
        // as bounded as a prune.
        stmts.push(
          nulled
            ? {
                sql: `UPDATE oplog SET payload = NULL, v = 2, payload_hash = ?, prev_hash = ?, hash = ?
                      WHERE id = ?`,
                args: [after.payload_hash, after.prev_hash, after.hash, after.id],
              }
            : {
                sql: `UPDATE oplog SET v = 2, payload_hash = ?, prev_hash = ?, hash = ?
                      WHERE id = ?`,
                args: [after.payload_hash, after.prev_hash, after.hash, after.id],
              },
        );
      }
      const plan = planner.finish(compactedAt);

      if (opts?.dryRun) {
        return {
          entriesRewritten: plan.entriesRewritten,
          erasedCount: plan.erasedCount,
          prunedCount: plan.prunedCount,
          payloadBytesBefore: plan.payloadBytesBefore,
          payloadBytesAfter: plan.payloadBytesAfter,
          previousHeadHash: plan.previousHeadHash,
          compactedAt,
          dryRun: true,
          vacuum: { ok: false, bytesReclaimed: null, detail: "dry run — nothing written" },
        };
      }

      // Order is irrelevant (every statement touches a distinct id), and all
      // of them still ride in the one batch = one transaction below.
      const NULL_CHUNK = 400;
      for (let i = 0; i < nullOnly.length; i += NULL_CHUNK) {
        const ids = nullOnly.slice(i, i + NULL_CHUNK);
        stmts.push({
          sql: `UPDATE oplog SET payload = NULL WHERE id IN (${ids.map(() => "?").join(",")})`,
          args: ids,
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
      this.oplogEpoch++;

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
        prunedCount: plan.prunedCount,
        payloadBytesBefore: plan.payloadBytesBefore,
        payloadBytesAfter: plan.payloadBytesAfter,
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

function rowToEntry(row: Row): OplogEntry {
  return {
    id: Number(row.id),
    ts: String(row.ts),
    op: String(row.op) as OplogOp,
    scope: String(row.scope),
    key: String(row.key),
    payload: row.payload === null ? null : decode<unknown>(row.payload),
    v: row.v === null || row.v === undefined ? 1 : Number(row.v),
    payload_hash:
      row.payload_hash === null || row.payload_hash === undefined
        ? null
        : String(row.payload_hash),
    prev_hash: String(row.prev_hash),
    hash: String(row.hash),
  };
}
