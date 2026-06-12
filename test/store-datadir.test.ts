//
// Regression: StoreLibsql must create its parent directory before opening a
// local file: URL. libSQL/SQLite does not create missing dirs and fails with
// SQLITE_CANTOPEN, which crashed the daemon on a first run against a fresh
// MEMWARDEN_DATA_DIR. Construct against a deeply-nested non-existent path and
// confirm it opens and works.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreLibsql } from "../src/state/store-libsql.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("StoreLibsql data-dir creation", () => {
  it("creates a missing nested parent dir and opens cleanly (no SQLITE_CANTOPEN)", async () => {
    const root = mkdtempSync(join(tmpdir(), "mw-store-"));
    dirs.push(root);
    const fresh = join(root, "does", "not", "exist", "yet");
    expect(existsSync(fresh)).toBe(false);

    const store = new StoreLibsql({ url: `file:${join(fresh, "memwarden.db")}` });
    // a write proves the connection actually opened
    await store.set("scope", "k", { v: 1 });
    expect(await store.get("scope", "k")).toEqual({ v: 1 });
    expect(existsSync(fresh)).toBe(true);
  });
});
