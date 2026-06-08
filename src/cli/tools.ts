//
// Tool adapter registry — the per-tool knowledge that lets `memwarden up`
// wire one local brain into every AI coding tool. Each adapter knows that
// tool's user-scope config file and how to merge the memwarden MCP server
// into it in the tool's exact schema. The merges are pure string->string so
// they are unit-testable without touching the filesystem; the thin fs
// wrapper (writeTool) is the only side-effecting part.
//
// Config locations verified against each tool's 2026 docs:
//   claude-code  ~/.claude.json                       (mcpServers)
//   cursor       ~/.cursor/mcp.json                   (mcpServers)
//   kiro         ~/.kiro/settings/mcp.json            (mcpServers)
//   antigravity  ~/.gemini/config/mcp_config.json     (mcpServers; shared by IDE/CLI)
//   opencode     ~/.config/opencode/opencode.json     (mcp -> {type,command[],environment})
//   openclaw     ~/.openclaw/openclaw.json            (mcp.servers)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How the memwarden MCP server is launched (stdio). */
export interface LaunchInfo {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Whether memory flows automatically, and by what mechanism. */
export type AutoMode = "hooks" | "agents-md";

export interface ToolAdapter {
  id: string;
  label: string;
  /** User-scope config file for this tool, rooted at `home`. */
  configPath(home: string): string;
  /** Heuristic: does this tool appear installed for this user? */
  detect(home: string): boolean;
  /**
   * Merge the memwarden MCP server into the tool's existing config text
   * (null when the file does not exist yet). Returns the new file text.
   * Throws if `existing` is present but not parseable — the caller skips
   * rather than clobber a config it cannot understand.
   */
  merge(existing: string | null, launch: LaunchInfo): string;
  /** How recall/capture happens for this tool, for the summary + wiring. */
  auto: AutoMode;
}

type Json = Record<string, unknown>;

/** Parse existing config, or {} when absent. Throws on present-but-corrupt. */
function parseOrEmpty(existing: string | null): Json {
  if (existing === null) return {};
  const trimmed = existing.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Json;
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}

function serialize(obj: Json): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

// --- per-schema merges ---------------------------------------------

/** The common `{ mcpServers: { memwarden: {command,args,env} } }` shape. */
function mergeMcpServers(existing: string | null, launch: LaunchInfo): string {
  const base = parseOrEmpty(existing);
  base["mcpServers"] = {
    ...asObject(base["mcpServers"]),
    memwarden: { command: launch.command, args: launch.args, env: launch.env },
  };
  return serialize(base);
}

/** OpenCode: `mcp` map, `type:"local"`, command is one array, `environment`. */
function mergeOpencode(existing: string | null, launch: LaunchInfo): string {
  const base = parseOrEmpty(existing);
  if (!base["$schema"]) base["$schema"] = "https://opencode.ai/config.json";
  base["mcp"] = {
    ...asObject(base["mcp"]),
    memwarden: {
      type: "local",
      command: [launch.command, ...launch.args],
      enabled: true,
      environment: launch.env,
    },
  };
  return serialize(base);
}

/** OpenClaw: servers live one level down, under `mcp.servers`. */
function mergeOpenclaw(existing: string | null, launch: LaunchInfo): string {
  const base = parseOrEmpty(existing);
  const mcp = asObject(base["mcp"]);
  mcp["servers"] = {
    ...asObject(mcp["servers"]),
    memwarden: { command: launch.command, args: launch.args, env: launch.env },
  };
  base["mcp"] = mcp;
  return serialize(base);
}

/**
 * Codex uses TOML (~/.codex/config.toml), not JSON. We can't safely re-parse
 * arbitrary TOML without a parser, so we touch only our own table: strip a
 * prior [mcp_servers.memwarden] table (header through the line before the
 * next table or EOF), then append a fresh one. Every other table is left
 * byte-for-byte intact. Idempotent.
 */
function codexBlock(launch: LaunchInfo): string {
  const args = launch.args.map((a) => JSON.stringify(a)).join(", ");
  const env = Object.entries(launch.env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(", ");
  return (
    "[mcp_servers.memwarden]\n" +
    `command = ${JSON.stringify(launch.command)}\n` +
    `args = [${args}]\n` +
    (env ? `env = { ${env} }\n` : "")
  );
}

function mergeCodexToml(existing: string | null, launch: LaunchInfo): string {
  const block = codexBlock(launch);
  if (!existing || !existing.trim()) return block;
  const stripped = existing
    .replace(/\[mcp_servers\.memwarden\][\s\S]*?(?=\n\[|$)/, "")
    .replace(/\s*$/, "");
  return stripped ? stripped + "\n\n" + block : block;
}

// --- the registry --------------------------------------------------

export const TOOLS: ToolAdapter[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    configPath: (home) => join(home, ".claude.json"),
    detect: (home) =>
      existsSync(join(home, ".claude.json")) || existsSync(join(home, ".claude")),
    merge: mergeMcpServers,
    auto: "hooks", // also gets SessionStart/PostToolUse hooks (true auto)
  },
  {
    id: "codex",
    label: "Codex",
    configPath: (home) => join(home, ".codex", "config.toml"),
    detect: (home) => existsSync(join(home, ".codex")),
    merge: mergeCodexToml,
    auto: "agents-md",
  },
  {
    id: "cursor",
    label: "Cursor",
    configPath: (home) => join(home, ".cursor", "mcp.json"),
    detect: (home) => existsSync(join(home, ".cursor")),
    merge: mergeMcpServers,
    auto: "agents-md",
  },
  {
    id: "kiro",
    label: "Kiro",
    configPath: (home) => join(home, ".kiro", "settings", "mcp.json"),
    detect: (home) => existsSync(join(home, ".kiro")),
    merge: mergeMcpServers,
    auto: "agents-md",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    configPath: (home) => join(home, ".gemini", "config", "mcp_config.json"),
    detect: (home) => existsSync(join(home, ".gemini")),
    merge: mergeMcpServers,
    auto: "agents-md",
  },
  {
    id: "opencode",
    label: "OpenCode",
    configPath: (home) => join(home, ".config", "opencode", "opencode.json"),
    detect: (home) =>
      existsSync(join(home, ".config", "opencode")) ||
      existsSync(join(home, ".opencode")),
    merge: mergeOpencode,
    auto: "agents-md",
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    configPath: (home) => join(home, ".openclaw", "openclaw.json"),
    detect: (home) => existsSync(join(home, ".openclaw")),
    merge: mergeOpenclaw,
    auto: "agents-md",
  },
];

export function toolById(id: string): ToolAdapter | undefined {
  return TOOLS.find((t) => t.id === id);
}

// --- AGENTS.md: instruction-driven auto-recall ---------------------
//
// Tools without a hook system (Cursor, Antigravity, OpenCode, …) can't be
// made to auto-recall mechanically. The cross-tool lever is AGENTS.md (the
// Linux Foundation standard read by Cursor, Gemini/Antigravity, OpenCode,
// Codex): a project instruction telling the agent to use the memory tools at
// task boundaries. Soft (the agent must follow it) but it is how the
// ecosystem gets automatic behavior without hooks.

const AGENTS_START = "<!-- memwarden:start -->";
const AGENTS_END = "<!-- memwarden:end -->";

export function memwardenAgentsBlock(): string {
  return [
    AGENTS_START,
    "## Memory (memwarden)",
    "",
    "This project shares one memory across all your AI tools (memwarden).",
    "",
    "- At the **start of a task**, recall prior context: call the `memory_resume` tool, or type `/recall <topic>`.",
    "- When you learn a **durable fact, decision, or fix**, call `memory_remember` so the next session — in any tool — has it.",
    AGENTS_END,
    "",
  ].join("\n");
}

/** Insert/replace the memwarden block in an AGENTS.md body. Idempotent. */
export function mergeAgentsMd(existing: string | null): string {
  const block = memwardenAgentsBlock();
  if (!existing || !existing.trim()) return `# AGENTS.md\n\n${block}`;
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end !== -1 && end > start) {
    return (
      existing.slice(0, start) +
      block.trimEnd() +
      existing.slice(end + AGENTS_END.length)
    );
  }
  return existing.replace(/\s*$/, "") + "\n\n" + block;
}

export function writeAgentsMd(dir: string): { path: string; created: boolean } {
  const path = join(dir, "AGENTS.md");
  const created = !existsSync(path);
  const existing = created ? null : readFileSync(path, "utf8");
  writeFileSync(path, mergeAgentsMd(existing), "utf8");
  return { path, created };
}

export interface WireResult {
  id: string;
  label: string;
  path: string;
  status: "wired" | "skipped";
  reason?: string;
}

/**
 * Write/merge the memwarden MCP server into one tool's config. Safe by
 * default: if the existing file cannot be parsed, it is left untouched and
 * the result is reported as skipped (never clobbered).
 */
export function writeTool(
  adapter: ToolAdapter,
  home: string,
  launch: LaunchInfo,
): WireResult {
  const path = adapter.configPath(home);
  let existing: string | null = null;
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, "utf8");
    } catch (err) {
      return {
        id: adapter.id,
        label: adapter.label,
        path,
        status: "skipped",
        reason: `could not read (${err instanceof Error ? err.message : err})`,
      };
    }
  }
  let next: string;
  try {
    next = adapter.merge(existing, launch);
  } catch {
    return {
      id: adapter.id,
      label: adapter.label,
      path,
      status: "skipped",
      reason: "existing config is not valid JSON — left untouched",
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, "utf8");
  return { id: adapter.id, label: adapter.label, path, status: "wired" };
}
