//
// `memwarden connect` config writing. Pure merge logic plus a filesystem
// round-trip against a temp dir — no global state, no network.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMcpServerEntry,
  mergeMcpConfig,
  writeMcpConfig,
  mcpConfigPathFor,
} from "../src/cli/connect.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "memwarden-connect-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("buildMcpServerEntry", () => {
  it("defaults to the local daemon, omits secret when absent", () => {
    const e = buildMcpServerEntry();
    expect(e.command).toBe("npx");
    expect(e.args).toEqual(["-y", "@memwarden/mcp"]);
    expect(e.env).toEqual({ MEMWARDEN_URL: "http://localhost:3111" });
  });
  it("includes url and secret when given", () => {
    const e = buildMcpServerEntry({ url: "http://h:9", secret: "x" });
    expect(e.env).toEqual({ MEMWARDEN_URL: "http://h:9", MEMWARDEN_SECRET: "x" });
  });
});

describe("mergeMcpConfig", () => {
  it("adds memwarden without clobbering existing servers", () => {
    const existing = { mcpServers: { other: { command: "foo" } } };
    const merged = mergeMcpConfig(existing, buildMcpServerEntry());
    expect(merged.mcpServers).toHaveProperty("other");
    expect(merged.mcpServers).toHaveProperty("memwarden");
    // input not mutated
    expect(Object.keys(existing.mcpServers)).toEqual(["other"]);
  });
  it("handles null/empty existing config", () => {
    const merged = mergeMcpConfig(null, buildMcpServerEntry());
    expect(Object.keys(merged.mcpServers ?? {})).toEqual(["memwarden"]);
  });
});

describe("writeMcpConfig", () => {
  it("creates .mcp.json when absent", () => {
    const dir = tempDir();
    const path = mcpConfigPathFor("claude-code", dir);
    const { created } = writeMcpConfig(path);
    expect(created).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.mcpServers.memwarden.args).toEqual(["-y", "@memwarden/mcp"]);
  });

  it("merges into an existing .mcp.json, preserving other servers", () => {
    const dir = tempDir();
    const path = join(dir, ".mcp.json");
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { existing: { command: "keep" } } }),
    );
    const { created } = writeMcpConfig(path, { url: "http://localhost:3111" });
    expect(created).toBe(false);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.mcpServers.existing.command).toBe("keep");
    expect(written.mcpServers.memwarden.env.MEMWARDEN_URL).toBe(
      "http://localhost:3111",
    );
  });

  it("recovers from a corrupt config by starting fresh", () => {
    const dir = tempDir();
    const path = join(dir, ".mcp.json");
    writeFileSync(path, "{ not json");
    writeMcpConfig(path);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.mcpServers).toHaveProperty("memwarden");
  });

  it("creates nested parent dirs if needed", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "deep", ".mcp.json");
    writeMcpConfig(path);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toHaveProperty(
      "memwarden",
    );
  });
});
