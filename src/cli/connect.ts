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
  // Override the command that launches the MCP server. Defaults to the
  // published package via npx; the CLI passes the local built bin so it
  // works before publish.
  mcpCommand?: string;
  mcpArgs?: string[];
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
  return {
    command: opts.mcpCommand ?? "npx",
    args: opts.mcpArgs ?? ["-y", "@memwarden/mcp"],
    env,
  };
}

interface HookCommand {
  type: "command";
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

/** Claude Code settings path for hooks, rooted at `dir`. */
export function claudeSettingsPathFor(dir: string): string {
  return join(dir, ".claude", "settings.json");
}

/**
 * Build the SessionStart (auto-inject) + PostToolUse (auto-capture) hook
 * groups. `hookBase` is the shell command that runs the memwarden CLI, e.g.
 * `"node" "/abs/dist/cli/bin.js"`; the event subcommand is appended.
 */
// Trailing shell comment stamped on every hook command we write, so we can
// recognize our own entries on re-run WITHOUT a loose `includes("memwarden")`
// that would also match (and then delete) a user's own hook that merely
// mentions memwarden (e.g. a custom logging wrapper).
const MEMWARDEN_HOOK_MARKER = "# memwarden-managed";

export function buildClaudeHooks(hookBase: string): Record<string, HookGroup[]> {
  return {
    SessionStart: [
      { hooks: [{ type: "command", command: `${hookBase} hook session-start ${MEMWARDEN_HOOK_MARKER}` }] },
    ],
    PostToolUse: [
      { matcher: "*", hooks: [{ type: "command", command: `${hookBase} hook capture ${MEMWARDEN_HOOK_MARKER}` }] },
    ],
  };
}

function isMemwardenHookGroup(g: HookGroup): boolean {
  // Match our marker (current writes) or the exact subcommand strings we have
  // always written (legacy entries from before the marker), so upgrades clean
  // up old entries without duplicating. NOT a broad substring match.
  return g.hooks.some(
    (h) =>
      h.command.includes(MEMWARDEN_HOOK_MARKER) ||
      /\bhook (?:session-start|capture)\b/.test(h.command),
  );
}

/**
 * Merge memwarden's hooks into an existing Claude settings object without
 * disturbing the user's other hooks. Idempotent: prior memwarden entries
 * for an event are replaced, not duplicated. Pure; does not mutate input.
 */
export function mergeClaudeHooks(
  existing: ClaudeSettings | null,
  hookBase: string,
): ClaudeSettings {
  const base: ClaudeSettings = existing && typeof existing === "object" ? existing : {};
  const ours = buildClaudeHooks(hookBase);
  const hooks: Record<string, HookGroup[]> = { ...(base.hooks ?? {}) };
  for (const event of Object.keys(ours)) {
    const kept = (hooks[event] ?? []).filter((g) => !isMemwardenHookGroup(g));
    hooks[event] = [...kept, ...(ours[event] ?? [])];
  }
  return { ...base, hooks };
}

/** Write/merge the Claude Code hooks settings file. */
export function writeClaudeHooks(
  settingsPath: string,
  hookBase: string,
): { path: string; created: boolean } {
  let existing: ClaudeSettings | null = null;
  const created = !existsSync(settingsPath);
  if (!created) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettings;
    } catch {
      existing = null;
    }
  }
  const merged = mergeClaudeHooks(existing, hookBase);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return { path: settingsPath, created };
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
      // An existing-but-unparseable config is NOT ours to overwrite —
      // clobbering it would wipe every MCP server the user configured (and
      // editor configs increasingly allow comments / trailing commas, which
      // fail strict JSON.parse). Refuse and leave the file untouched, matching
      // tools.ts's safe-by-default behavior.
      throw new Error(
        `refusing to overwrite ${configPath}: it exists but is not valid JSON. ` +
          `Fix or remove it, then re-run.`,
      );
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
