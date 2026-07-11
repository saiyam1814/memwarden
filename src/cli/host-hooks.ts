//
// Native lifecycle-hook adapters — the per-host knowledge that makes memory
// capture + injection mechanical (no instruction-file dependence). Each
// adapter knows one host's hook config file and schema and merges memwarden's
// two hooks (session-start inject, capture) into it without disturbing the
// user's own hooks. Formats verified against each host's docs (July 2026):
//
//   claude-code  ~/.claude/settings.json          hooks: {Event:[{matcher?,hooks:[{type,command}]}]}
//   codex        ~/.codex/hooks.json              same Claude-style schema; SessionStart/PostToolUse
//   cursor       ~/.cursor/hooks.json             {version:1, hooks:{sessionStart:[{command}],postToolUse:[{command}]}}
//   gemini       ~/.gemini/settings.json          hooks key, PascalCase events (SessionStart/AfterTool)
//   kiro         ~/.kiro/agents/*.json            hooks key per custom agent (agentSpawn/postToolUse)
//   opencode     ~/.config/opencode/plugins/      a self-contained plugin file that shells to the CLI
//
// The merges are pure string->string (unit-testable without a filesystem);
// the thin fs wrappers never clobber a file they cannot parse. Removal is
// sentinel-driven: an entry is ours iff its command invokes our exact hook
// subcommands, so `down` never deletes a user hook that merely mentions
// memwarden.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { HookHost } from "./hook.js";
import { writeClaudeHooks, removeClaudeHooks } from "./connect.js";

// A command is ours iff it runs the memwarden hook subcommands we have ever
// written. Precise on purpose: NOT a loose `includes("memwarden")` that would
// also match (and then delete) a user's own wrapper script.
export const MEMWARDEN_CMD_RE = /\bhook (?:session-start|capture)\b/;

function sessionStartCmd(hookBase: string, host: HookHost): string {
  return `${hookBase} hook session-start --host ${host}`;
}
function captureCmd(hookBase: string, host: HookHost): string {
  return `${hookBase} hook capture --host ${host}`;
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
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function serialize(obj: Json): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

// --- Claude-style schema (codex, gemini) ----------------------------
// { hooks: { Event: [ { matcher?, hooks: [{type:"command",command}] } ] } }

function claudeStyleGroup(command: string, matcher?: string): Json {
  return {
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: "command", command }],
  };
}

function claudeStyleGroupIsOurs(group: unknown): boolean {
  return asArray(asObject(group)["hooks"]).some((h) => {
    const cmd = asObject(h)["command"];
    return typeof cmd === "string" && MEMWARDEN_CMD_RE.test(cmd);
  });
}

function mergeClaudeStyleHooks(
  existing: string | null,
  events: Record<string, Json[]>,
): string {
  const base = parseOrEmpty(existing);
  const hooks = { ...asObject(base["hooks"]) };
  for (const [event, ours] of Object.entries(events)) {
    const kept = asArray(hooks[event]).filter((g) => !claudeStyleGroupIsOurs(g));
    hooks[event] = [...kept, ...ours];
  }
  base["hooks"] = hooks;
  return serialize(base);
}

/** Remove our groups. Returns the new text, or null when nothing changed. */
function removeClaudeStyleHooks(existing: string): string | null {
  const base = parseOrEmpty(existing);
  const hooks = asObject(base["hooks"]);
  let changed = false;
  const next: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = asArray(groups).filter((g) => !claudeStyleGroupIsOurs(g));
    if (kept.length !== asArray(groups).length) changed = true;
    if (kept.length > 0) next[event] = kept;
  }
  if (!changed) return null;
  if (Object.keys(next).length > 0) base["hooks"] = next;
  else delete base["hooks"];
  return serialize(base);
}

// --- flat-entry schema (cursor, kiro) --------------------------------
// hooks.event is an array of { command, matcher? } entries directly.

function flatEntryIsOurs(entry: unknown): boolean {
  const cmd = asObject(entry)["command"];
  return typeof cmd === "string" && MEMWARDEN_CMD_RE.test(cmd);
}

function mergeFlatHooks(
  hooks: Json,
  events: Record<string, Json[]>,
): Json {
  const next = { ...hooks };
  for (const [event, ours] of Object.entries(events)) {
    const kept = asArray(next[event]).filter((e) => !flatEntryIsOurs(e));
    next[event] = [...kept, ...ours];
  }
  return next;
}

function removeFlatHooks(hooks: Json): { hooks: Json; changed: boolean } {
  let changed = false;
  const next: Json = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = asArray(entries).filter((e) => !flatEntryIsOurs(e));
    if (kept.length !== asArray(entries).length) changed = true;
    if (kept.length > 0) next[event] = kept;
  }
  return { hooks: next, changed };
}

// --- per-host pure merges/removes ------------------------------------

/** Codex: ~/.codex/hooks.json, Claude-style. No SessionEnd — capture rides
 * PostToolUse. Hooks must be trust-pinned via /hooks inside Codex. */
export function mergeCodexHooks(existing: string | null, hookBase: string): string {
  return mergeClaudeStyleHooks(existing, {
    SessionStart: [claudeStyleGroup(sessionStartCmd(hookBase, "codex"))],
    PostToolUse: [claudeStyleGroup(captureCmd(hookBase, "codex"))],
  });
}
export function removeCodexHooks(existing: string): string | null {
  return removeClaudeStyleHooks(existing);
}

/** Gemini CLI: hooks key in ~/.gemini/settings.json, PascalCase events.
 * Matcher "" is the documented match-everything form. */
export function mergeGeminiHooks(existing: string | null, hookBase: string): string {
  return mergeClaudeStyleHooks(existing, {
    SessionStart: [claudeStyleGroup(sessionStartCmd(hookBase, "gemini"), "")],
    AfterTool: [claudeStyleGroup(captureCmd(hookBase, "gemini"), "")],
  });
}
export function removeGeminiHooks(existing: string): string | null {
  return removeClaudeStyleHooks(existing);
}

/** Cursor: ~/.cursor/hooks.json {version:1, hooks:{camelCase events}} with
 * flat {command} entries. sessionStart may return additional_context;
 * postToolUse carries tool_output. */
export function mergeCursorHooks(existing: string | null, hookBase: string): string {
  const base = parseOrEmpty(existing);
  if (typeof base["version"] !== "number") base["version"] = 1;
  base["hooks"] = mergeFlatHooks(asObject(base["hooks"]), {
    sessionStart: [{ command: sessionStartCmd(hookBase, "cursor") }],
    postToolUse: [{ command: captureCmd(hookBase, "cursor") }],
  });
  return serialize(base);
}
export function removeCursorHooks(existing: string): string | null {
  const base = parseOrEmpty(existing);
  const { hooks, changed } = removeFlatHooks(asObject(base["hooks"]));
  if (!changed) return null;
  base["hooks"] = hooks;
  return serialize(base);
}

/** Kiro: hooks live inside each custom-agent config (~/.kiro/agents/*.json).
 * agentSpawn stdout is added to context (inject); postToolUse captures. */
export function mergeKiroAgentHooks(existing: string, hookBase: string): string {
  const base = parseOrEmpty(existing);
  base["hooks"] = mergeFlatHooks(asObject(base["hooks"]), {
    agentSpawn: [{ command: sessionStartCmd(hookBase, "kiro") }],
    postToolUse: [{ matcher: "*", command: captureCmd(hookBase, "kiro") }],
  });
  return serialize(base);
}
export function removeKiroAgentHooks(existing: string): string | null {
  const base = parseOrEmpty(existing);
  const { hooks, changed } = removeFlatHooks(asObject(base["hooks"]));
  if (!changed) return null;
  if (Object.keys(hooks).length > 0) base["hooks"] = hooks;
  else delete base["hooks"];
  return serialize(base);
}

// --- OpenCode plugin ---------------------------------------------------
// OpenCode has no hook config file; it loads in-process plugins from
// ~/.config/opencode/plugins/. We generate one self-contained file that
// shells out to the memwarden CLI (which owns daemon URL + secret), so the
// plugin itself carries no credentials. The sentinel comment is what makes
// the file recognizably ours — removal only ever deletes a sentinel file.

export const OPENCODE_PLUGIN_SENTINEL = "// memwarden:managed";

export function opencodePluginSource(nodeBin: string, cliBin: string): string {
  return `${OPENCODE_PLUGIN_SENTINEL} — written by \`memwarden up\`, removed by \`memwarden down --all\`.
// Bridges OpenCode's plugin hooks to the local memwarden daemon via the
// memwarden CLI (which resolves the daemon URL and secret itself). Capture
// rides tool.execute.after; injection rides the first chat message of a
// session. Everything is best-effort: a downed daemon never breaks a turn.

import { spawn } from "node:child_process";

const NODE = ${JSON.stringify(nodeBin)};
const CLI = ${JSON.stringify(cliBin)};

function runHook(sub: string, event: unknown): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (out: string) => {
      if (!done) {
        done = true;
        resolve(out);
      }
    };
    try {
      const child = spawn(NODE, [CLI, "hook", sub, "--host", "opencode"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish("");
      }, 10_000);
      child.stdout.on("data", (c: unknown) => (out += String(c)));
      child.on("close", () => {
        clearTimeout(timer);
        finish(out);
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish("");
      });
      child.stdin.write(JSON.stringify(event ?? {}));
      child.stdin.end();
    } catch {
      finish("");
    }
  });
}

export const MemwardenPlugin = async ({ directory }: { directory?: string }) => {
  const cwd = directory ?? process.cwd();
  const injectedSessions = new Set<string>();
  return {
    // Capture: every executed tool flows to the daemon's observe path.
    "tool.execute.after": async (input: any, output: any) => {
      try {
        await runHook("capture", {
          sessionId: input?.sessionID ?? input?.sessionId,
          cwd,
          toolName: input?.tool ?? input?.name,
          toolInput: output?.args ?? input?.args ?? {},
          toolOutput: output?.output ?? output?.result ?? "",
        });
      } catch {}
    },
    // Inject: once per session, append this project's verified memory to the
    // first message's parts. Defensive on shape — if OpenCode's payload
    // differs, this silently does nothing rather than breaking chat.
    "chat.message": async (_input: any, output: any) => {
      try {
        const sessionId =
          output?.message?.sessionID ?? output?.message?.sessionId ?? "session";
        if (injectedSessions.has(sessionId)) return;
        injectedSessions.add(sessionId);
        const ctx = await runHook("session-start", { sessionId, cwd });
        if (ctx && Array.isArray(output?.parts)) {
          output.parts.push({ type: "text", text: ctx, synthetic: true });
        }
      } catch {}
    },
  };
};
`;
}

// --- the registry ------------------------------------------------------

export interface HostWireResult {
  id: string;
  label: string;
  path: string;
  status: "wired" | "skipped" | "removed" | "unchanged";
  reason?: string;
}

export interface HostHookAdapter {
  id: HookHost;
  label: string;
  /** Heuristic: does this host appear installed for this user? */
  detect(home: string): boolean;
  /** Merge memwarden's hooks into this host's config(s). Never clobbers. */
  write(home: string, hookBase: string): HostWireResult[];
  /** Remove only memwarden's entries from this host's config(s). */
  remove(home: string): HostWireResult[];
  /** True when a memwarden hook command is present in this host's config. */
  wired(home: string): boolean;
  /** Per-host guidance printed by `up` after wiring. */
  note?: string;
}

/** write() for the common one-JSON-file case: read, pure-merge, write. */
function writeSingleFile(
  adapter: { id: string; label: string },
  path: string,
  merge: (existing: string | null) => string,
): HostWireResult {
  let existing: string | null = null;
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, "utf8");
    } catch (err) {
      return {
        ...adapter,
        path,
        status: "skipped",
        reason: `could not read (${err instanceof Error ? err.message : err})`,
      };
    }
  }
  let next: string;
  try {
    next = merge(existing);
  } catch {
    return {
      ...adapter,
      path,
      status: "skipped",
      reason: "existing config is not valid JSON — left untouched",
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, "utf8");
  return { ...adapter, path, status: "wired" };
}

/** remove() for the one-JSON-file case: absent/unparseable/foreign = no-op. */
function removeSingleFile(
  adapter: { id: string; label: string },
  path: string,
  removeText: (existing: string) => string | null,
): HostWireResult {
  if (!existsSync(path)) return { ...adapter, path, status: "unchanged" };
  let existing: string;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    return { ...adapter, path, status: "unchanged" };
  }
  let next: string | null;
  try {
    next = removeText(existing);
  } catch {
    return {
      ...adapter,
      path,
      status: "skipped",
      reason: "existing config is not valid JSON — left untouched",
    };
  }
  if (next === null) return { ...adapter, path, status: "unchanged" };
  writeFileSync(path, next, "utf8");
  return { ...adapter, path, status: "removed" };
}

function fileMentionsOurHooks(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return MEMWARDEN_CMD_RE.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function kiroAgentFiles(home: string): string[] {
  const dir = join(home, ".kiro", "agents");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function opencodePluginPath(home: string): string {
  return join(home, ".config", "opencode", "plugins", "memwarden.ts");
}

export const HOST_HOOKS: HostHookAdapter[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detect: (home) =>
      existsSync(join(home, ".claude.json")) || existsSync(join(home, ".claude")),
    write: (home, hookBase) => {
      // Delegates to the connect.ts implementation (marker-based, already
      // shipping) so Claude Code has exactly one hooks writer.
      const path = join(home, ".claude", "settings.json");
      try {
        writeClaudeHooks(path, hookBase);
        return [{ id: "claude-code", label: "Claude Code", path, status: "wired" }];
      } catch {
        return [
          {
            id: "claude-code",
            label: "Claude Code",
            path,
            status: "skipped",
            reason: "existing settings.json is not valid JSON — left untouched",
          },
        ];
      }
    },
    remove: (home) => {
      const { path, removed } = removeClaudeHooks(join(home, ".claude", "settings.json"));
      return [
        {
          id: "claude-code",
          label: "Claude Code",
          path,
          status: removed ? "removed" : "unchanged",
        },
      ];
    },
    wired: (home) => fileMentionsOurHooks(join(home, ".claude", "settings.json")),
  },
  {
    id: "codex",
    label: "Codex",
    detect: (home) => existsSync(join(home, ".codex")),
    write: (home, hookBase) => [
      writeSingleFile(
        { id: "codex", label: "Codex" },
        join(home, ".codex", "hooks.json"),
        (existing) => mergeCodexHooks(existing, hookBase),
      ),
    ],
    remove: (home) => [
      removeSingleFile(
        { id: "codex", label: "Codex" },
        join(home, ".codex", "hooks.json"),
        removeCodexHooks,
      ),
    ],
    wired: (home) => fileMentionsOurHooks(join(home, ".codex", "hooks.json")),
    note:
      "Codex requires hooks to be trusted before they run: open Codex and run /hooks to review and trust the memwarden entries.",
  },
  {
    id: "cursor",
    label: "Cursor",
    detect: (home) => existsSync(join(home, ".cursor")),
    write: (home, hookBase) => [
      writeSingleFile(
        { id: "cursor", label: "Cursor" },
        join(home, ".cursor", "hooks.json"),
        (existing) => mergeCursorHooks(existing, hookBase),
      ),
    ],
    remove: (home) => [
      removeSingleFile(
        { id: "cursor", label: "Cursor" },
        join(home, ".cursor", "hooks.json"),
        removeCursorHooks,
      ),
    ],
    wired: (home) => fileMentionsOurHooks(join(home, ".cursor", "hooks.json")),
    note:
      "Cursor also natively runs Claude Code hooks from ~/.claude/settings.json; the native ~/.cursor/hooks.json written here makes memwarden explicit in Cursor's own config.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    detect: (home) => existsSync(join(home, ".gemini")),
    write: (home, hookBase) => [
      writeSingleFile(
        { id: "gemini", label: "Gemini CLI" },
        join(home, ".gemini", "settings.json"),
        (existing) => mergeGeminiHooks(existing, hookBase),
      ),
    ],
    remove: (home) => [
      removeSingleFile(
        { id: "gemini", label: "Gemini CLI" },
        join(home, ".gemini", "settings.json"),
        removeGeminiHooks,
      ),
    ],
    wired: (home) => fileMentionsOurHooks(join(home, ".gemini", "settings.json")),
    note:
      "These are Gemini CLI settings.json hooks; the ~/.gemini family (Gemini CLI, Antigravity) shares this directory, but only Gemini CLI executes them.",
  },
  {
    id: "kiro",
    label: "Kiro",
    detect: (home) => existsSync(join(home, ".kiro")),
    write: (home, hookBase) => {
      const files = kiroAgentFiles(home);
      if (files.length === 0) {
        return [
          {
            id: "kiro",
            label: "Kiro",
            path: join(home, ".kiro", "agents"),
            status: "skipped",
            reason:
              "Kiro attaches hooks per custom agent and no agent configs exist yet — create one, then re-run memwarden up",
          },
        ];
      }
      return files.map((path) =>
        writeSingleFile({ id: "kiro", label: "Kiro" }, path, (existing) =>
          mergeKiroAgentHooks(existing ?? "{}", hookBase),
        ),
      );
    },
    remove: (home) =>
      kiroAgentFiles(home).map((path) =>
        removeSingleFile({ id: "kiro", label: "Kiro" }, path, removeKiroAgentHooks),
      ),
    wired: (home) => kiroAgentFiles(home).some(fileMentionsOurHooks),
    note:
      "Kiro hooks attach to custom agents (~/.kiro/agents); agents created later need a re-run of memwarden up.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    detect: (home) =>
      existsSync(join(home, ".config", "opencode")) ||
      existsSync(join(home, ".opencode")),
    write: (home, hookBase) => {
      const path = opencodePluginPath(home);
      // hookBase is `"{node}" "{cli}"`; the plugin spawns them unquoted.
      const parts = hookBase.match(/"([^"]+)"\s+"([^"]+)"/);
      if (!parts) {
        return [
          {
            id: "opencode",
            label: "OpenCode",
            path,
            status: "skipped",
            reason: "could not derive node/CLI paths from the hook command",
          },
        ];
      }
      if (existsSync(path)) {
        try {
          const existing = readFileSync(path, "utf8");
          if (!existing.startsWith(OPENCODE_PLUGIN_SENTINEL)) {
            return [
              {
                id: "opencode",
                label: "OpenCode",
                path,
                status: "skipped",
                reason: "a non-memwarden file already exists there — left untouched",
              },
            ];
          }
        } catch {
          return [
            { id: "opencode", label: "OpenCode", path, status: "skipped", reason: "could not read existing plugin" },
          ];
        }
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, opencodePluginSource(parts[1]!, parts[2]!), "utf8");
      return [{ id: "opencode", label: "OpenCode", path, status: "wired" }];
    },
    remove: (home) => {
      const path = opencodePluginPath(home);
      if (!existsSync(path)) {
        return [{ id: "opencode", label: "OpenCode", path, status: "unchanged" }];
      }
      try {
        const existing = readFileSync(path, "utf8");
        if (!existing.startsWith(OPENCODE_PLUGIN_SENTINEL)) {
          return [
            {
              id: "opencode",
              label: "OpenCode",
              path,
              status: "skipped",
              reason: "file at the plugin path is not memwarden's — left untouched",
            },
          ];
        }
      } catch {
        return [{ id: "opencode", label: "OpenCode", path, status: "unchanged" }];
      }
      rmSync(path);
      return [{ id: "opencode", label: "OpenCode", path, status: "removed" }];
    },
    wired: (home) => {
      const path = opencodePluginPath(home);
      if (!existsSync(path)) return false;
      try {
        return readFileSync(path, "utf8").startsWith(OPENCODE_PLUGIN_SENTINEL);
      } catch {
        return false;
      }
    },
    note: "OpenCode loads plugins at startup — restart OpenCode once to activate.",
  },
];

export function hostHookById(id: string): HostHookAdapter | undefined {
  return HOST_HOOKS.find((h) => h.id === id);
}

/**
 * Which of these tool ids still need the AGENTS.md instruction fallback:
 * the ones no hook adapter covers. Antigravity rides the gemini adapter
 * (the ~/.gemini family shares its settings.json hooks).
 */
export function hooklessToolIds(toolIds: string[]): string[] {
  return toolIds.filter((id) => !hostHookById(id) && id !== "antigravity");
}
