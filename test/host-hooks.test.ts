//
// Per-host hook config writers/removers. Pure merge logic plus filesystem
// round-trips against a fake $HOME in a temp dir — no network, no real
// configs touched. The invariants under test: never clobber user hooks,
// never clobber unparseable files, idempotent re-runs, removal strips only
// entries whose command is recognizably ours.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeCodexHooks,
  removeCodexHooks,
  mergeCursorHooks,
  removeCursorHooks,
  mergeGeminiHooks,
  removeGeminiHooks,
  mergeKiroAgentHooks,
  removeKiroAgentHooks,
  opencodePluginSource,
  OPENCODE_PLUGIN_SENTINEL,
  HOST_HOOKS,
  hostHookById,
  hooklessToolIds,
} from "../src/cli/host-hooks.js";
import { unmergeAgentsMd, removeAgentsMd, writeAgentsMd, mergeAgentsMd } from "../src/cli/tools.js";
import { unmergeClaudeHooks, mergeClaudeHooks } from "../src/cli/connect.js";

const BASE = '"node" "/abs/bin.js"';

const dirs: string[] = [];
function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "memwarden-host-hooks-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("grok hooks (~/.grok/hooks/memwarden.json — a drop-in file we own)", () => {
  const grok = () => hostHookById("grok")!;
  const hookFile = (home: string) => join(home, ".grok", "hooks", "memwarden.json");

  it("writes the Claude-schema events under a `hooks` key, addressed --host grok", () => {
    const home = tempHome();
    mkdirSync(join(home, ".grok"), { recursive: true });
    const [res] = grok().write(home, BASE);
    expect(res!.status).toBe("wired");

    const out = JSON.parse(readFileSync(hookFile(home), "utf8"));
    expect(out.hooks.SessionStart[0].hooks[0].command).toContain(
      "hook session-start --host grok",
    );
    expect(out.hooks.PostToolUse[0].hooks[0].command).toContain("hook capture --host grok");
    expect(out.hooks.UserPromptSubmit[0].hooks[0].command).toContain("hook prompt --host grok");
    expect(out.hooks.SessionEnd[0].hooks[0].command).toContain("hook session-end --host grok");
  });

  it("is idempotent, and removal deletes only our file — never a user's other hook file", () => {
    const home = tempHome();
    mkdirSync(join(home, ".grok", "hooks"), { recursive: true });
    // A neighbouring hook file the user owns. Grok reads every *.json here, so
    // `down` must not touch it.
    const theirs = join(home, ".grok", "hooks", "their-hook.json");
    writeFileSync(theirs, JSON.stringify({ hooks: { SessionStart: [] } }), "utf8");

    grok().write(home, BASE);
    const first = readFileSync(hookFile(home), "utf8");
    grok().write(home, BASE);
    expect(readFileSync(hookFile(home), "utf8")).toBe(first);
    expect(grok().wired(home)).toBe(true);

    const [removed] = grok().remove(home);
    expect(removed!.status).toBe("removed");
    expect(existsSync(hookFile(home))).toBe(false);
    expect(existsSync(theirs)).toBe(true); // untouched
    expect(grok().wired(home)).toBe(false);
  });

  it("removing when nothing of ours exists reports unchanged, not an error", () => {
    const home = tempHome();
    mkdirSync(join(home, ".grok"), { recursive: true });
    const [res] = grok().remove(home);
    expect(res!.status).toBe("unchanged");
  });
});

describe("codex hooks (Claude-style schema in ~/.codex/hooks.json)", () => {
  it("writes SessionStart + PostToolUse with --host codex", () => {
    const out = JSON.parse(mergeCodexHooks(null, BASE));
    expect(out.hooks.SessionStart[0].hooks[0].command).toContain("hook session-start --host codex");
    expect(out.hooks.PostToolUse[0].hooks[0].command).toContain("hook capture --host codex");
    expect(out.hooks.PostToolUse[0].hooks[0].type).toBe("command");
  });

  it("writes the session journal events: UserPromptSubmit + Stop (no SessionEnd in Codex)", () => {
    const out = JSON.parse(mergeCodexHooks(null, BASE));
    expect(out.hooks.UserPromptSubmit[0].hooks[0].command).toContain("hook prompt --host codex");
    expect(out.hooks.Stop[0].hooks[0].command).toContain("hook session-end --host codex");
    expect(out.hooks.SessionEnd).toBeUndefined();
  });

  it("removal strips the journal events too", () => {
    const removed = JSON.parse(removeCodexHooks(mergeCodexHooks(null, BASE))!);
    expect(removed.hooks?.UserPromptSubmit).toBeUndefined();
    expect(removed.hooks?.Stop).toBeUndefined();
  });

  it("preserves user hooks and is idempotent", () => {
    const user = JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "my-audit" }] }] },
    });
    const once = mergeCodexHooks(user, BASE);
    const twice = JSON.parse(mergeCodexHooks(once, BASE));
    expect(twice.hooks.PostToolUse.filter((g: { hooks: Array<{ command: string }> }) => g.hooks[0].command === "my-audit")).toHaveLength(1);
    expect(twice.hooks.PostToolUse.filter((g: { hooks: Array<{ command: string }> }) => g.hooks[0].command.includes("hook capture"))).toHaveLength(1);
  });

  it("remove strips only ours, keeps the user's, null when nothing of ours", () => {
    const merged = mergeCodexHooks(
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "banner" }] }] }, model: "o5" }),
      BASE,
    );
    const removed = JSON.parse(removeCodexHooks(merged)!);
    expect(removed.hooks.SessionStart).toHaveLength(1);
    expect(removed.hooks.SessionStart[0].hooks[0].command).toBe("banner");
    expect(removed.hooks.PostToolUse).toBeUndefined();
    expect(removed.model).toBe("o5"); // unrelated keys untouched
    expect(removeCodexHooks(JSON.stringify(removed))).toBeNull();
  });

  it("throws on an unparseable existing file (caller skips, never clobbers)", () => {
    expect(() => mergeCodexHooks("{ not json", BASE)).toThrow();
  });
});

describe("cursor hooks (~/.cursor/hooks.json, version 1, camelCase events)", () => {
  it("writes version 1 with flat sessionStart/postToolUse entries", () => {
    const out = JSON.parse(mergeCursorHooks(null, BASE));
    expect(out.version).toBe(1);
    expect(out.hooks.sessionStart[0].command).toContain("hook session-start --host cursor");
    expect(out.hooks.postToolUse[0].command).toContain("hook capture --host cursor");
  });

  it("keeps the user's version and entries; removal restores them exactly", () => {
    const user = JSON.stringify({
      version: 1,
      hooks: { postToolUse: [{ command: "./lint.sh" }], stop: [{ command: "./notify.sh" }] },
    });
    const merged = mergeCursorHooks(user, BASE);
    const removed = JSON.parse(removeCursorHooks(merged)!);
    expect(removed.hooks.postToolUse).toEqual([{ command: "./lint.sh" }]);
    expect(removed.hooks.stop).toEqual([{ command: "./notify.sh" }]);
    expect(removed.hooks.sessionStart).toBeUndefined();
  });

  it("is idempotent across re-runs", () => {
    const twice = JSON.parse(mergeCursorHooks(mergeCursorHooks(null, BASE), BASE));
    expect(twice.hooks.sessionStart).toHaveLength(1);
    expect(twice.hooks.postToolUse).toHaveLength(1);
    expect(twice.hooks.beforeSubmitPrompt).toHaveLength(1);
    expect(twice.hooks.sessionEnd).toHaveLength(1);
  });

  it("writes the session journal events: beforeSubmitPrompt + sessionEnd", () => {
    const out = JSON.parse(mergeCursorHooks(null, BASE));
    expect(out.hooks.beforeSubmitPrompt[0].command).toContain("hook prompt --host cursor");
    expect(out.hooks.sessionEnd[0].command).toContain("hook session-end --host cursor");
    const removed = JSON.parse(removeCursorHooks(mergeCursorHooks(null, BASE))!);
    expect(removed.hooks.beforeSubmitPrompt).toBeUndefined();
    expect(removed.hooks.sessionEnd).toBeUndefined();
  });
});

describe("gemini hooks (hooks key in ~/.gemini/settings.json, PascalCase)", () => {
  it("writes SessionStart + AfterTool with the documented matcher form", () => {
    const out = JSON.parse(mergeGeminiHooks(null, BASE));
    expect(out.hooks.SessionStart[0].matcher).toBe("");
    expect(out.hooks.SessionStart[0].hooks[0].command).toContain("--host gemini");
    expect(out.hooks.AfterTool[0].hooks[0].command).toContain("hook capture --host gemini");
  });

  it("writes the session journal events: BeforeAgent + SessionEnd", () => {
    const out = JSON.parse(mergeGeminiHooks(null, BASE));
    expect(out.hooks.BeforeAgent[0].hooks[0].command).toContain("hook prompt --host gemini");
    expect(out.hooks.SessionEnd[0].hooks[0].command).toContain("hook session-end --host gemini");
  });

  it("leaves the user's other settings.json keys alone", () => {
    const user = JSON.stringify({ theme: "dark", mcpServers: { x: {} } });
    const merged = JSON.parse(mergeGeminiHooks(user, BASE));
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers).toEqual({ x: {} });
    const removed = JSON.parse(removeGeminiHooks(JSON.stringify(merged))!);
    expect(removed.theme).toBe("dark");
    expect(removed.hooks).toBeUndefined(); // fully ours -> key dropped
  });
});

describe("kiro hooks (per custom-agent config)", () => {
  it("merges agentSpawn (inject) + postToolUse matcher * (capture) into an agent", () => {
    const agent = JSON.stringify({ name: "my-agent", prompt: "helper" });
    const out = JSON.parse(mergeKiroAgentHooks(agent, BASE));
    expect(out.name).toBe("my-agent");
    expect(out.hooks.agentSpawn[0].command).toContain("hook session-start --host kiro");
    expect(out.hooks.postToolUse[0]).toMatchObject({ matcher: "*" });
    expect(out.hooks.postToolUse[0].command).toContain("hook capture --host kiro");
  });

  it("keeps the agent's own hooks; removal restores them", () => {
    const agent = JSON.stringify({
      name: "a",
      hooks: { postToolUse: [{ matcher: "fs_write", command: "cargo fmt --all" }] },
    });
    const merged = mergeKiroAgentHooks(agent, BASE);
    const removed = JSON.parse(removeKiroAgentHooks(merged)!);
    expect(removed.hooks.postToolUse).toEqual([{ matcher: "fs_write", command: "cargo fmt --all" }]);
    expect(removed.hooks.agentSpawn).toBeUndefined();
  });

  it("writes the session journal events: userPromptSubmit + stop; removal strips them", () => {
    const out = JSON.parse(mergeKiroAgentHooks("{}", BASE));
    expect(out.hooks.userPromptSubmit[0].command).toContain("hook prompt --host kiro");
    expect(out.hooks.stop[0].command).toContain("hook session-end --host kiro");
    const removed = JSON.parse(removeKiroAgentHooks(mergeKiroAgentHooks("{}", BASE))!);
    expect(removed.hooks).toBeUndefined(); // everything was ours
  });
});

describe("opencode plugin", () => {
  it("generates a sentinel-marked, self-contained plugin with baked paths", () => {
    const src = opencodePluginSource("/usr/bin/node", "/abs/dist/cli/bin.js");
    expect(src.startsWith(OPENCODE_PLUGIN_SENTINEL)).toBe(true);
    expect(src).toContain('"/usr/bin/node"');
    expect(src).toContain('"/abs/dist/cli/bin.js"');
    expect(src).toContain('"--host", "opencode"');
    expect(src).toContain("tool.execute.after");
  });

  it("bridges the session journal: prompt capture on chat.message, handoff on session.idle", () => {
    const src = opencodePluginSource("/usr/bin/node", "/abs/dist/cli/bin.js");
    expect(src).toContain('runHook("prompt"');
    expect(src).toContain('runHook("session-end"');
    expect(src).toContain("session.idle");
    // capture must skip the synthetic part our own injection pushes
    expect(src).toContain("!p?.synthetic");
  });

  it("write refuses to clobber a foreign file at the plugin path", () => {
    const home = tempHome();
    const adapter = hostHookById("opencode")!;
    const path = join(home, ".config", "opencode", "plugins", "memwarden.ts");
    mkdirSync(join(home, ".config", "opencode", "plugins"), { recursive: true });
    writeFileSync(path, "// the user's own plugin\n", "utf8");
    const [r] = adapter.write(home, BASE);
    expect(r!.status).toBe("skipped");
    expect(readFileSync(path, "utf8")).toBe("// the user's own plugin\n");
    // and remove leaves it alone too
    const [rm] = adapter.remove(home);
    expect(rm!.status).toBe("skipped");
    expect(existsSync(path)).toBe(true);
  });

  it("write + remove round-trip deletes only our sentinel file", () => {
    const home = tempHome();
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const adapter = hostHookById("opencode")!;
    const [w] = adapter.write(home, BASE);
    expect(w!.status).toBe("wired");
    expect(adapter.wired(home)).toBe(true);
    const [rm] = adapter.remove(home);
    expect(rm!.status).toBe("removed");
    expect(existsSync(w!.path)).toBe(false);
  });
});

describe("adapter registry round-trips against a fake $HOME", () => {
  it("codex/cursor/gemini: write -> wired -> remove -> not wired", () => {
    const home = tempHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".gemini"), { recursive: true });
    for (const id of ["codex", "cursor", "gemini"] as const) {
      const adapter = hostHookById(id)!;
      expect(adapter.detect(home)).toBe(true);
      const results = adapter.write(home, BASE);
      expect(results.every((r) => r.status === "wired")).toBe(true);
      expect(adapter.wired(home)).toBe(true);
      const removed = adapter.remove(home);
      expect(removed.some((r) => r.status === "removed")).toBe(true);
      expect(adapter.wired(home)).toBe(false);
    }
  });

  it("kiro: no agent configs -> honest skip with guidance; with agents -> each wired", () => {
    const home = tempHome();
    mkdirSync(join(home, ".kiro"), { recursive: true });
    const adapter = hostHookById("kiro")!;
    const [none] = adapter.write(home, BASE);
    expect(none!.status).toBe("skipped");
    expect(none!.reason).toContain("no agent configs");

    mkdirSync(join(home, ".kiro", "agents"), { recursive: true });
    writeFileSync(join(home, ".kiro", "agents", "a.json"), JSON.stringify({ name: "a" }));
    writeFileSync(join(home, ".kiro", "agents", "b.json"), JSON.stringify({ name: "b" }));
    const results = adapter.write(home, BASE);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "wired")).toBe(true);
    expect(adapter.wired(home)).toBe(true);
    adapter.remove(home);
    expect(adapter.wired(home)).toBe(false);
  });

  it("an unparseable existing config is skipped, never clobbered", () => {
    const home = tempHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const path = join(home, ".cursor", "hooks.json");
    writeFileSync(path, "{ trailing-comma: yes, }", "utf8");
    const [r] = hostHookById("cursor")!.write(home, BASE);
    expect(r!.status).toBe("skipped");
    expect(readFileSync(path, "utf8")).toBe("{ trailing-comma: yes, }");
  });

  it("AGENTS.md is a fallback: only hook-less tools qualify", () => {
    const all = ["claude-code", "codex", "cursor", "kiro", "antigravity", "opencode", "openclaw"];
    // openclaw is the only detected tool with no hook coverage; antigravity
    // rides the gemini adapter (shared ~/.gemini settings.json hooks).
    expect(hooklessToolIds(all)).toEqual(["openclaw"]);
    expect(hooklessToolIds(["claude-code", "cursor"])).toEqual([]);
  });

  it("every registry adapter carries a distinct hook host id", () => {
    const ids = HOST_HOOKS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
    expect(ids).toContain("cursor");
    expect(ids).toContain("gemini");
    expect(ids).toContain("kiro");
    expect(ids).toContain("opencode");
  });
});

describe("recognizer regex (MEMWARDEN_CMD_RE)", () => {
  it("matches all four subcommands and nothing loose", async () => {
    const { MEMWARDEN_CMD_RE } = await import("../src/cli/host-hooks.js");
    for (const sub of ["session-start", "session-end", "capture", "prompt"]) {
      expect(MEMWARDEN_CMD_RE.test(`"node" "/x/bin.js" hook ${sub} --host codex`)).toBe(true);
    }
    // a user's own wrapper that merely mentions memwarden is NOT ours
    expect(MEMWARDEN_CMD_RE.test("my-memwarden-logger.sh")).toBe(false);
    expect(MEMWARDEN_CMD_RE.test("echo hook promptly")).toBe(false);
  });
});

describe("claude hooks (connect.ts) — session journal events", () => {
  it("mergeClaudeHooks writes UserPromptSubmit + SessionEnd; unmerge strips them", () => {
    const merged = mergeClaudeHooks(null, BASE);
    const cmd = (event: string) => merged.hooks![event]![0]!.hooks[0]!.command;
    expect(cmd("UserPromptSubmit")).toContain("hook prompt");
    expect(cmd("SessionEnd")).toContain("hook session-end");
    expect(unmergeClaudeHooks(merged)).toEqual({});
  });
});

describe("claude hooks removal (connect.ts)", () => {
  it("unmergeClaudeHooks strips marker-era and legacy entries, keeps the user's", () => {
    const merged = mergeClaudeHooks(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        },
      },
      BASE,
    );
    const next = unmergeClaudeHooks(merged)!;
    expect(next.hooks!.SessionStart).toHaveLength(1);
    expect(next.hooks!.SessionStart![0]!.hooks[0]!.command).toBe("echo hi");
    expect(next.hooks!.PostToolUse).toBeUndefined();
    // nothing of ours left -> null (no write needed)
    expect(unmergeClaudeHooks(next)).toBeNull();
  });
});

describe("AGENTS.md removal (tools.ts)", () => {
  it("strips only the sentinel block and keeps user prose", () => {
    const user = "# AGENTS.md\n\nHouse rules: be kind to the linter.\n";
    const merged = mergeAgentsMd(user);
    const next = unmergeAgentsMd(merged)!;
    expect(next).toContain("House rules");
    expect(next).not.toContain("memwarden");
    expect(unmergeAgentsMd(user)).toBeNull(); // no block -> nothing to do
  });

  it("removeAgentsMd deletes the file when we created all of it", () => {
    const dir = tempHome();
    const { path } = writeAgentsMd(dir);
    expect(existsSync(path)).toBe(true);
    const r = removeAgentsMd(dir);
    expect(r.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("removeAgentsMd trims the block but keeps a file with user content", () => {
    const dir = tempHome();
    writeFileSync(join(dir, "AGENTS.md"), "# AGENTS.md\n\nKeep me.\n", "utf8");
    writeAgentsMd(dir);
    const r = removeAgentsMd(dir);
    expect(r.removed).toBe(true);
    const rest = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(rest).toContain("Keep me.");
    expect(rest).not.toContain("memwarden");
  });
});
