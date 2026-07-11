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
  buildAuditPlan,
  detectStoreKind,
  extractFileRefs,
  renderAuditHtml,
  type AuditReport,
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

  it("does not catastrophically backtrack on adversarial input (ReDoS guard)", () => {
    const evil = "a/".repeat(20000) + "x".repeat(200000) + " no-dot-ending";
    const start = Date.now();
    extractFileRefs(evil);
    expect(Date.now() - start).toBeLessThan(1000); // was ~4.7s before the bound
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
    expect(r.plan?.map((p) => p.id)).toContain("quarantine-missing-file-memory");
    expect(r.plan?.map((p) => p.id)).toContain("record-capture-time-evidence");
    expect(r.plan?.map((p) => p.id)).toContain("anchor-unanchored-memory");
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
    expect(r.plan?.[0]?.priority).toBe("critical");
    expect(r.plan?.map((p) => p.id)).toContain("refresh-drifted-code-memory");
    expect(r.plan?.map((p) => p.id)).toContain("promote-present-to-verified-recall");
  });

  it("treats space-separated no-timezone timestamps as UTC (SQLite CURRENT_TIMESTAMP)", async () => {
    const repo = makeRepo(); // moved.ts mtime = NEW (2026-06-01), stable.ts = OLD
    const store = tempDir();
    const dbPath = join(store, "claude-mem.db");
    const db = createClient({ url: `file:${dbPath}` });
    await db.execute("CREATE TABLE observations (id TEXT, narrative TEXT, files TEXT, created_at TEXT)");
    // "2026-03-01 00:00:00" — SQLite's UTC convention, NO 'Z'. Parsed as local
    // tz this would shift hours and flip the drift verdict. stable.ts (mtime
    // OLD, before MID) must read PRESENT regardless of the host timezone.
    await db.execute({
      sql: "INSERT INTO observations VALUES (?, ?, ?, ?)",
      args: ["o1", "constant in src/stable.ts", "[]", "2026-03-01 00:00:00"],
    });
    db.close();
    const r = await auditStore(dbPath, repo);
    expect(r.driftCheckable).toBe(true);
    expect(r.present).toBe(1); // not falsely DRIFTED by a tz offset
    expect(r.drifted.length).toBe(0);
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

const sampleAuditReport: AuditReport = {
  store: "/x/claude-mem.db",
  kind: "sqlite",
  root: "/repo",
  total: 4,
  anchored: 3,
  uniqueFiles: 3,
  missing: [
    { id: "m1", title: "auth in <script>src/gone.ts</script>", origin: "obs", status: "missing", detail: "no longer exists: src/gone.ts" },
  ],
  drifted: [
    { id: "m2", title: "refactor done", origin: "obs", status: "drifted", detail: "changed after capture: src/moved.ts" },
  ],
  present: 1,
  unanchored: 1,
  driftCheckable: true,
};

describe("renderAuditHtml", () => {
  it("produces a self-contained HTML document with the verdict and findings", () => {
    const html = renderAuditHtml(sampleAuditReport);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // self-contained: no external script/style/link references
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script\b/);
    expect(html).toContain("/x/claude-mem.db");
    expect(html).toContain("memories scanned");
    expect(html).toMatch(/<b>4<\/b>\s*memories scanned/);
    // the verdict math: 2 of 3 anchored are red/yellow = 67%
    expect(html).toContain("2 of 3");
    expect(html).toContain("67%");
    expect(html).toContain("src/gone.ts");
    expect(html).toContain("Action plan");
    expect(html).toContain("Quarantine memories whose referenced files are gone");
  });

  it("escapes HTML in titles/details (no injection from store content)", () => {
    const html = renderAuditHtml(sampleAuditReport);
    expect(html).not.toContain("<script>src/gone.ts</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles a store with nothing anchored", () => {
    const empty: AuditReport = {
      ...sampleAuditReport,
      total: 2,
      anchored: 0,
      uniqueFiles: 0,
      missing: [],
      drifted: [],
      present: 0,
      unanchored: 2,
    };
    const html = renderAuditHtml(empty);
    expect(html).toContain("Nothing in this store references a file");
  });
});

describe("buildAuditPlan", () => {
  it("turns audit evidence into deterministic next actions", () => {
    const plan = buildAuditPlan(sampleAuditReport);
    expect(plan.map((p) => p.id)).toEqual([
      "quarantine-missing-file-memory",
      "refresh-drifted-code-memory",
      "promote-present-to-verified-recall",
      "anchor-unanchored-memory",
      "wire-live-memory-firewall",
    ]);
    expect(plan[0]).toMatchObject({
      priority: "critical",
      dimension: "D7_CONTROL_SAFETY",
    });
    expect(plan.some((p) => p.command === "npm install -g memwarden && memwarden up")).toBe(true);
  });

  it("emits a useful empty-store action", () => {
    const empty: AuditReport = {
      ...sampleAuditReport,
      total: 0,
      anchored: 0,
      uniqueFiles: 0,
      missing: [],
      drifted: [],
      present: 0,
      unanchored: 0,
    };
    expect(buildAuditPlan(empty)).toEqual([
      expect.objectContaining({
        id: "no-memory-found",
        priority: "low",
      }),
    ]);
  });
});
