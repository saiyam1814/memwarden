//
// Tool adapter registry: each tool's MCP config is written in that tool's
// exact schema, merges preserve other servers, are idempotent, and a corrupt
// existing config is left untouched (safe-by-default). Plus the AGENTS.md
// auto-recall block.

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  TOOLS,
  toolById,
  writeTool,
  unwireTool,
  toolWireState,
  writeAgentsMd,
  removeAgentsMd,
  mergeAgentsMd,
  stripAgentsMd,
  type LaunchInfo,
} from "../src/cli/tools.js";

const launch: LaunchInfo = {
  command: "node",
  args: ["/abs/dist/mcp/bin.js"],
  env: { MEMWARDEN_URL: "http://localhost:3111" },
};

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "memwarden-tools-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function merged(id: string, existing: string | null = null): Record<string, any> {
  return JSON.parse(toolById(id)!.merge(existing, launch));
}

describe("tool registry", () => {
  it("has all target tools", () => {
    expect(TOOLS.map((t) => t.id).sort()).toEqual(
      ["antigravity", "claude-code", "codex", "cursor", "kiro", "opencode", "openclaw"].sort(),
    );
  });

  it("writes Codex's TOML [mcp_servers.memwarden] table", () => {
    const once = toolById("codex")!.merge(null, launch);
    expect(once).toContain("[mcp_servers.memwarden]");
    expect(once).toContain('command = "node"');
    expect(once).toContain('args = ["/abs/dist/mcp/bin.js"]');
    expect(once).toContain("MEMWARDEN_URL");
    // preserves other TOML tables + idempotent
    const existing = '[model]\nname = "gpt-5"\n\n[mcp_servers.github]\ncommand = "gh"\n';
    const merged = toolById("codex")!.merge(existing, launch);
    expect(merged).toContain('[model]');
    expect(merged).toContain('[mcp_servers.github]');
    expect(merged).toContain("[mcp_servers.memwarden]");
    expect(toolById("codex")!.merge(merged, launch)).toBe(merged); // idempotent
    expect(toolById("codex")!.merge(once, launch)).toBe(once); // idempotent from-empty form
  });

  it("writes the mcpServers schema for cursor/kiro/antigravity/claude-code", () => {
    for (const id of ["cursor", "kiro", "antigravity", "claude-code"]) {
      const o = merged(id);
      expect(o["mcpServers"].memwarden.command).toBe("node");
      expect(o["mcpServers"].memwarden.args).toEqual(["/abs/dist/mcp/bin.js"]);
      expect(o["mcpServers"].memwarden.env.MEMWARDEN_URL).toContain("3111");
    }
  });

  it("writes OpenCode's mcp/type/command-array/environment schema", () => {
    const o = merged("opencode");
    expect(o["mcp"].memwarden.type).toBe("local");
    expect(o["mcp"].memwarden.command).toEqual(["node", "/abs/dist/mcp/bin.js"]);
    expect(o["mcp"].memwarden.environment.MEMWARDEN_URL).toContain("3111");
    expect(o["$schema"]).toContain("opencode");
    expect(o["mcp"].memwarden.enabled).toBe(true);
  });

  it("writes OpenClaw's nested mcp.servers schema", () => {
    const o = merged("openclaw");
    expect(o["mcp"].servers.memwarden.command).toBe("node");
    expect(o["mcp"].servers.memwarden.args).toEqual(["/abs/dist/mcp/bin.js"]);
  });

  it("preserves existing servers and is idempotent (mcpServers)", () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: "x" } },
      somethingElse: 42,
    });
    const once = toolById("cursor")!.merge(existing, launch);
    const twice = toolById("cursor")!.merge(once, launch);
    expect(twice).toBe(once); // idempotent
    const o = JSON.parse(once);
    expect(o.mcpServers.other.command).toBe("x"); // preserved
    expect(o.somethingElse).toBe(42); // preserved
    expect(o.mcpServers.memwarden).toBeDefined();
  });

  it("preserves existing servers and is idempotent (OpenClaw)", () => {
    const existing = JSON.stringify({
      mcp: { servers: { foo: { command: "f" } }, parallel: true },
    });
    const once = toolById("openclaw")!.merge(existing, launch);
    const twice = toolById("openclaw")!.merge(once, launch);
    expect(twice).toBe(once);
    const o = JSON.parse(once);
    expect(o.mcp.servers.foo.command).toBe("f"); // preserved
    expect(o.mcp.parallel).toBe(true); // sibling key preserved
    expect(o.mcp.servers.memwarden).toBeDefined();
  });
});

describe("writeTool — filesystem, safe by default", () => {
  it("creates the config file at the tool's user-scope path", () => {
    const home = tmp();
    const r = writeTool(toolById("cursor")!, home, launch);
    expect(r.status).toBe("wired");
    expect(r.path).toBe(join(home, ".cursor", "mcp.json"));
    const o = JSON.parse(readFileSync(r.path, "utf8"));
    expect(o.mcpServers.memwarden).toBeDefined();
  });

  it("leaves an unparseable existing config untouched", () => {
    const home = tmp();
    const p = join(home, ".cursor", "mcp.json");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ this is not json ");
    const r = writeTool(toolById("cursor")!, home, launch);
    expect(r.status).toBe("skipped");
    expect(readFileSync(p, "utf8")).toBe("{ this is not json "); // untouched
  });
});

describe("AGENTS.md auto-recall block", () => {
  it("creates a block instructing the agent to use memory", () => {
    const out = mergeAgentsMd(null);
    expect(out).toContain("memwarden:start");
    expect(out).toContain("memory_resume");
    expect(out).toContain("/recall");
    expect(out).toContain("memory_remember");
  });

  it("is idempotent and preserves surrounding content", () => {
    const withOther = "# My Project\n\nSome existing rules.\n";
    const m1 = mergeAgentsMd(withOther);
    expect(m1).toContain("Some existing rules.");
    expect(m1).toContain("memwarden:start");
    expect(mergeAgentsMd(m1)).toBe(m1); // idempotent
  });

  it("writes ./AGENTS.md", () => {
    const dir = tmp();
    const r = writeAgentsMd(dir);
    expect(r.created).toBe(true);
    expect(r.path).toBe(join(dir, "AGENTS.md"));
    expect(readFileSync(r.path, "utf8")).toContain("memwarden:start");
  });
});

describe("unwire (memwarden down --all)", () => {
  it("unmerge removes exactly our entry and keeps other servers, per schema", () => {
    for (const id of ["cursor", "kiro", "antigravity", "claude-code"]) {
      const withBoth = toolById(id)!.merge(
        JSON.stringify({ mcpServers: { github: { command: "gh" } } }),
        launch,
      );
      const out = toolById(id)!.unmerge(withBoth)!;
      const o = JSON.parse(out);
      expect(o.mcpServers.memwarden).toBeUndefined();
      expect(o.mcpServers.github.command).toBe("gh");
      // nothing of ours -> null (honest "not wired")
      expect(toolById(id)!.unmerge(out)).toBeNull();
    }
  });

  it("unmerge strips only Codex's memwarden TOML table", () => {
    const existing = '[model]\nname = "gpt-5"\n';
    const withOurs = toolById("codex")!.merge(existing, launch);
    const out = toolById("codex")!.unmerge(withOurs)!;
    expect(out).toContain("[model]");
    expect(out).not.toContain("memwarden");
    expect(toolById("codex")!.unmerge(out)).toBeNull();
  });

  it("unmerge handles opencode and openclaw nesting", () => {
    const oc = toolById("opencode")!;
    const out = JSON.parse(oc.unmerge(oc.merge(null, launch))!);
    expect(out.mcp.memwarden).toBeUndefined();
    const ow = toolById("openclaw")!;
    const out2 = JSON.parse(ow.unmerge(ow.merge(null, launch))!);
    expect(out2.mcp.servers.memwarden).toBeUndefined();
  });

  it("unwireTool round-trips writeTool and toolWireState tracks it", () => {
    const home = tmp();
    const t = toolById("cursor")!;
    expect(toolWireState(t, home)).toBe("not wired");
    writeTool(t, home, launch);
    expect(toolWireState(t, home)).toBe("wired");
    const u = unwireTool(t, home);
    expect(u.status).toBe("removed");
    expect(toolWireState(t, home)).toBe("not wired");
    // second run reports honestly instead of pretending
    expect(unwireTool(t, home).reason).toBe("not wired");
  });

  it("unwireTool never clobbers an unparseable config", () => {
    const home = tmp();
    const t = toolById("cursor")!;
    const p = t.configPath(home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ this is not json ");
    const u = unwireTool(t, home);
    expect(u.status).toBe("skipped");
    expect(readFileSync(p, "utf8")).toBe("{ this is not json ");
  });

  it("stripAgentsMd removes our block, keeps user content, deletes when file was ours", () => {
    // user content survives
    const mixed = mergeAgentsMd("# My Project\n\nHouse rules.\n");
    const rest = stripAgentsMd(mixed)!;
    expect(rest).toContain("House rules.");
    expect(rest).not.toContain("memwarden");
    // a file we created from scratch reduces to "" (delete signal)
    expect(stripAgentsMd(mergeAgentsMd(null))).toBe("");
    // no block -> null
    expect(stripAgentsMd("# Plain\n")).toBeNull();
  });

  it("removeAgentsMd deletes the file when it was entirely ours", () => {
    const dir = tmp();
    writeAgentsMd(dir);
    const r = removeAgentsMd(dir);
    expect(r.action).toBe("deleted");
    expect(removeAgentsMd(dir).action).toBe("none");
  });
});
