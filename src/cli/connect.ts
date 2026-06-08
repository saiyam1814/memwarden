//
// `memwarden connect` — wires the local memwarden daemon into MCP clients so
// every agent shares one brain. The MCP config is the stable, universal
// unlock (same block works for Claude Code, Cursor, Claude Desktop, Cline,
// Windsurf), so that is what this writes. Auto-capture hooks are a separate,
// tool-specific follow-up.
//
// The merge logic is pure and testable; the filesystem wrapper is thin.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface ConnectOptions {
  url?: string; // memwarden daemon URL
  secret?: string;
}

/** The MCP server entry pointing at the memwarden MCP stdio adapter. */
export function buildMcpServerEntry(opts: ConnectOptions = {}): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const env: Record<string, string> = {
    MEMWARDEN_URL: opts.url ?? "http://localhost:3111",
  };
  if (opts.secret) env["MEMWARDEN_SECRET"] = opts.secret;
  return { command: "npx", args: ["-y", "@memwarden/mcp"], env };
}

type McpConfig = { mcpServers?: Record<string, unknown> };

/**
 * Merge the memwarden server into an existing MCP config without clobbering
 * other servers. Returns a new object; does not mutate the input.
 */
export function mergeMcpConfig(
  existing: McpConfig | null,
  entry: ReturnType<typeof buildMcpServerEntry>,
): McpConfig {
  const base: McpConfig = existing && typeof existing === "object" ? existing : {};
  return {
    ...base,
    mcpServers: { ...(base.mcpServers ?? {}), memwarden: entry },
  };
}

/**
 * Write/merge the MCP config file at `configPath`. Returns the path and the
 * resulting config. Creates parent directories as needed.
 */
export function writeMcpConfig(
  configPath: string,
  opts: ConnectOptions = {},
): { path: string; config: McpConfig; created: boolean } {
  let existing: McpConfig | null = null;
  const created = !existsSync(configPath);
  if (!created) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8")) as McpConfig;
    } catch {
      existing = null; // corrupt/non-JSON: start fresh rather than throw
    }
  }
  const merged = mergeMcpConfig(existing, buildMcpServerEntry(opts));
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return { path: configPath, config: merged, created };
}

/** Default MCP config path for a given target tool, rooted at `dir`. */
export function mcpConfigPathFor(target: string, dir: string): string {
  switch (target) {
    case "claude-code":
    case "cursor":
    case "cline":
    case "windsurf":
      // All of these read a project-level .mcp.json.
      return join(dir, ".mcp.json");
    default:
      return join(dir, ".mcp.json");
  }
}
