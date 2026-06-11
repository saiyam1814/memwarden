//
// The foreign-store audit: real fixture stores (SQLite via @libsql/client,
// markdown piles, Mem0-style JSON) audited against a real temp "repo".
// Drift uses the mtime fallback path here (fixtures are not git repos), set
// deterministically with utimesSync.

import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditStore,
  detectStoreKind,
  extractFileRefs,
} from "../src/functions/audit.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mw-audit-"));
  cleanups.push(d);
  return d;
}

const OLD = new Date("2026-01-01T00:00:00Z");
const MID = "2026-03-01T00:00:00Z"; // memory capture time
const NEW = new Date("2026-06-01T00:00:00Z");

/** A fake repo: one stable file, one changed-after-capture file. */
function makeRepo(): string {
  const repo = tempDir();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "stable.ts"), "export const a = 1;\n");
  utimesSync(join(repo, "src", "stable.ts"), OLD, OLD);
  writeFileSync(join(repo, "src", "moved.ts"), "export const b = 2;\n");
  utimesSync(join(repo, "src", "moved.ts"), NEW, NEW);
  return repo;
}

describe("extractFileRefs", () => {
  it("finds slash paths, strips line numbers and wrappers, skips URLs and versions", () => {
    const { pathRefs, bareRefs } = extractFileRefs(
      "fixed `src/app/auth.ts:42` (see https://x.dev/a/b.ts) and node/20.1.0; also touched utils.py",
    );
    expect(pathRefs).toEqual(["src/app/auth.ts"]);
    expect(bareRefs).toEqual(["utils.py"]);
  });

  it("does not double-count a bare name already covered by a path", () => {
    const { pathRefs, bareRefs } = extractFileRefs("auth.ts lives at src/auth.ts");
    expect(pathRefs).toEqual(["src/auth.ts"]);
    expect(bareRefs).toEqual([]);
  });
});

describe("audit: markdown pile", () => {
  it("classifies bullets by file existence; bare names never count as missing", async () => {
    const repo = makeRepo();
    const store = tempDir();
    writeFileSync(
      join(store, "CLAUDE.md"),
      [
        "# Project notes",
        "- auth logic lives in src/stable.ts and uses bearer tokens",
        "- the retry helper is in src/deleted-long-ago.ts",
        "- always run the linter before committing anything here",
        "- nonexistent-bare-name.ts handles the legacy flow",
      ].join("\n"),
    );
    const r = await auditStore(store, repo);
    expect(r.kind).toBe("markdown");
    expect(r.total).toBe(4);
    expect(r.present).toBe(1); // stable.ts exists
    expect(r.missing.length).toBe(1); // deleted-long-ago.ts
    expect(r.missing[0]!.detail).toContain("src/deleted-long-ago.ts");
    // linter bullet has no refs; bare name that doesn't resolve is ignored too
    expect(r.unanchored).toBe(2);
    // markdown has no timestamps -> drift not checkable
    expect(r.driftCheckable).toBe(false);
    expect(r.drifted.length).toBe(0);
  });
});

describe("audit: sqlite store (claude-mem-shaped)", () => {
  it("reads any schema, uses files columns and timestamps for drift", async () => {
    const repo = makeRepo();
    const store = tempDir();
    const dbPath = join(store, "claude-mem.db");
    const db = createClient({ url: `file:${dbPath}` });
    await db.execute(
      "CREATE TABLE observations (id TEXT, title TEXT, narrative TEXT, files TEXT, created_at TEXT)",
    );
    const insert =
      "INSERT INTO observations (id, title, narrative, files, created_at) VALUES (?, ?, ?, ?, ?)";
    await db.execute({
      sql: insert,
      args: ["o1", "stable fact", "the constant lives in src/stable.ts", "[]", MID],
    });
    await db.execute({
      sql: insert,
      args: ["o2", "drifted fact", "refactor done", JSON.stringify(["src/moved.ts"]), MID],
    });
    await db.execute({
      sql: insert,
      args: ["o3", "ghost fact", "see src/never-existed.ts for details", "[]", MID],
    });
    await db.execute({
      sql: insert,
      args: ["o4", "vibes", "we prefer small PRs and descriptive commits", "[]", MID],
    });
    db.close();

    const r = await auditStore(dbPath, repo);
    expect(r.kind).toBe("sqlite");
    expect(r.total).toBe(4);
    expect(r.present).toBe(1); // stable.ts unchanged since MID
    expect(r.drifted.length).toBe(1); // moved.ts mtime NEW > MID
    expect(r.drifted[0]!.id).toBe("o2");
    expect(r.missing.length).toBe(1);
    expect(r.missing[0]!.id).toBe("o3");
    expect(r.unanchored).toBe(1);
    expect(r.driftCheckable).toBe(true);
  });

  it("never modifies the original store file", async () => {
    const repo = makeRepo();
    const store = tempDir();
    const dbPath = join(store, "x.sqlite");
    const db = createClient({ url: `file:${dbPath}` });
    await db.execute("CREATE TABLE m (id TEXT, text TEXT)");
    await db.execute({
      sql: "INSERT INTO m VALUES (?, ?)",
      args: ["1", "notes about src/stable.ts internals"],
    });
    db.close();
    const before = new Date("2026-02-02T00:00:00Z");
    utimesSync(dbPath, before, before);
    await auditStore(dbPath, repo);
    const { statSync } = await import("node:fs");
    expect(statSync(dbPath).mtime.getTime()).toBe(before.getTime());
  });
});

describe("audit: json export (Mem0-shaped)", () => {
  it("reads results[] with memory text and created_at", async () => {
    const repo = makeRepo();
    const store = tempDir();
    const jsonPath = join(store, "mem0-export.json");
    writeFileSync(
      jsonPath,
      JSON.stringify({
        results: [
          { id: "m1", memory: "config parsing happens in src/stable.ts", created_at: MID },
          { id: "m2", memory: "user prefers dark mode", created_at: MID },
          { id: "m3", memory: "auth flow documented in src/never-existed.ts", created_at: MID },
        ],
      }),
    );
    const r = await auditStore(jsonPath, repo);
    expect(r.kind).toBe("json");
    expect(r.total).toBe(3);
    expect(r.present).toBe(1);
    expect(r.missing.length).toBe(1);
    expect(r.unanchored).toBe(1);
  });
});

describe("detectStoreKind", () => {
  it("detects by extension and content sniffing", async () => {
    const d = tempDir();
    writeFileSync(join(d, "a.json"), "[]");
    writeFileSync(join(d, "b.md"), "# notes");
    expect(detectStoreKind(join(d, "a.json"))).toBe("json");
    expect(detectStoreKind(join(d, "b.md"))).toBe("markdown");
    expect(detectStoreKind(d)).toBe("markdown");
    // extensionless JSON sniff
    writeFileSync(join(d, "noext"), '{"results": []}');
    expect(detectStoreKind(join(d, "noext"))).toBe("json");
    // real sqlite magic, weird extension
    const db = createClient({ url: `file:${join(d, "weird.store")}` });
    await db.execute("CREATE TABLE t (x TEXT)");
    db.close();
    expect(detectStoreKind(join(d, "weird.store"))).toBe("sqlite");
  });
});
