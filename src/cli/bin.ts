#!/usr/bin/env node
//
// memwarden CLI.
//
//   memwarden connect [tool]       # wire an MCP client to the local brain
//   memwarden export <file>        # write a portable Brain Bundle
//   memwarden import <file>        # load a Brain Bundle into the daemon
//
// connect writes ./.mcp.json so any MCP client shares the one local brain;
// export/import move your memory between machines via the daemon's API.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import {
  writeMcpConfig,
  mcpConfigPathFor,
  buildMcpServerEntry,
  writeClaudeHooks,
  claudeSettingsPathFor,
} from "./connect.js";
import { TOOLS, writeTool, writeAgentsMd, type LaunchInfo } from "./tools.js";
import { handleSessionStart, handleCapture, readStdin } from "./hook.js";

const DAEMON_URL = process.env.MEMWARDEN_URL ?? "http://localhost:3111";

// dist/cli/bin.js -> dist/index.js (the daemon entrypoint).
const DAEMON_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

// Absolute paths to the installed CLI and MCP bins, so the configs/hooks we
// write run today (pre-publish) regardless of cwd. dist/cli/bin.js -> here.
const SELF = fileURLToPath(import.meta.url);
const MCP_BIN = join(dirname(SELF), "..", "mcp", "bin.js");
const HOOK_BASE = `"${process.execPath}" "${SELF}"`;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (process.env.MEMWARDEN_SECRET) {
    h["authorization"] = `Bearer ${process.env.MEMWARDEN_SECRET}`;
  }
  return h;
}

function parseFlags(argv: string[]): {
  target: string;
  url: string | undefined;
  secret: string | undefined;
} {
  let target = "claude-code";
  let url: string | undefined;
  let secret: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") url = argv[++i];
    else if (a === "--secret") secret = argv[++i];
    else if (a && !a.startsWith("--")) target = a;
  }
  return { target, url, secret };
}

function connect(rest: string[]): void {
  const { target, url, secret } = parseFlags(rest);
  const withHooks = rest.includes("--with-hooks");
  // Launch the local built MCP bin so the config works before publish.
  const opts = {
    ...(url ? { url } : {}),
    ...(secret ? { secret } : {}),
    mcpCommand: process.execPath,
    mcpArgs: [MCP_BIN],
  };
  const path = mcpConfigPathFor(target, process.cwd());
  const { created } = writeMcpConfig(path, opts);
  console.log(
    `[memwarden] ${created ? "wrote" : "updated"} ${path} — '${target}' now shares the local brain.`,
  );

  if (withHooks) {
    const settings = claudeSettingsPathFor(process.cwd());
    writeClaudeHooks(settings, HOOK_BASE);
    console.log(
      `[memwarden] wrote ${settings} — SessionStart auto-injects this project's memory; PostToolUse auto-captures.`,
    );
  } else {
    console.log(
      `[memwarden] tip: add --with-hooks to auto-inject context on session start and capture automatically.`,
    );
  }
}

async function hook(rest: string[]): Promise<void> {
  const event = rest[0];
  const raw = await readStdin();
  const deps = {
    baseUrl: DAEMON_URL,
    ...(process.env.MEMWARDEN_SECRET ? { secret: process.env.MEMWARDEN_SECRET } : {}),
  };
  let out = "";
  if (event === "session-start") out = await handleSessionStart(raw, deps);
  else if (event === "capture") out = await handleCapture(raw, deps);
  if (out) process.stdout.write(out);
}

async function exportBrain(file: string | undefined): Promise<void> {
  if (!file) throw new Error("usage: memwarden export <file>");
  const res = await fetch(`${DAEMON_URL}/memwarden/export`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`export failed: HTTP ${res.status}`);
  const bundle = (await res.json()) as { sessions?: unknown[] };
  writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n", "utf8");
  console.log(
    `[memwarden] exported brain to ${file} (${bundle.sessions?.length ?? 0} sessions).`,
  );
}

async function doctor(rest: string[]): Promise<void> {
  const path = rest.find((a) => !a.startsWith("--")) ?? ".";
  const root = path === "." ? process.cwd() : path;
  const res = await fetch(`${DAEMON_URL}/memwarden/doctor`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ root }),
  });
  if (!res.ok) throw new Error(`doctor failed: HTTP ${res.status}`);
  const r = (await res.json()) as {
    total: number;
    safe: number;
    stale: Array<{ title: string; reason: string }>;
    unsourced: Array<{ title: string; reason: string }>;
  };
  console.log(`\nmemwarden doctor — ${root}\n`);
  console.log(`  SAFE TO INJECT: ${r.safe} memories`);
  console.log(`  STALE:          ${r.stale.length} memories reference files that changed`);
  console.log(`  UNSOURCED:      ${r.unsourced.length} memories have no evidence\n`);
  for (const s of r.stale.slice(0, 5)) console.log(`  [stale]     ${s.title} — ${s.reason}`);
  for (const u of r.unsourced.slice(0, 5)) console.log(`  [unsourced] ${u.title} — ${u.reason}`);
  console.log(`\n  ${r.total} memories audited.\n`);
}

async function importBrain(file: string | undefined): Promise<void> {
  if (!file) throw new Error("usage: memwarden import <file>");
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(`${DAEMON_URL}/memwarden/import`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(bundle),
  });
  const out = (await res.json()) as { imported?: unknown };
  if (!res.ok) throw new Error(`import failed: ${JSON.stringify(out)}`);
  console.log(`[memwarden] imported brain from ${file}:`, out.imported);
}

// --- daemon lifecycle ---------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function daemonAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/memwarden/livez`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure the daemon is up. If not, spawn it detached so it outlives this
 * shell, pointed at a stable user-global brain (~/.memwarden) so every tool
 * shares one memory regardless of where it was launched.
 */
async function ensureDaemon(
  url: string,
  dataDir: string,
): Promise<"already" | "started" | "failed"> {
  if (await daemonAlive(url)) return "already";
  // libSQL won't create the data directory; make it so the spawned daemon
  // can open its db instead of crashing silently on boot.
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MEMWARDEN_DATA_DIR: dataDir },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await daemonAlive(url)) return "started";
  }
  return "failed";
}

// --- `memwarden up` -----------------------------------------------

async function up(rest: string[]): Promise<void> {
  const { url, secret } = parseFlags(rest);
  const daemonUrl = url ?? DAEMON_URL;
  const home = homedir();
  const all = rest.includes("--all");
  const dataDir = process.env.MEMWARDEN_DATA_DIR ?? join(home, ".memwarden");

  console.log(`\nmemwarden up\n`);

  // 1. daemon — autostart it, but don't abort the wiring if it can't come up
  //    (the configs still point at it; the user can start it later).
  const state = await ensureDaemon(daemonUrl, dataDir);
  if (state === "failed") {
    console.log(
      `  daemon    ⚠ could not start at ${daemonUrl} (port in use?). ` +
        `Wiring tools anyway; start it with: node ${DAEMON_ENTRY}`,
    );
  } else {
    const brain = state === "already" ? "(already running)" : `brain: ${dataDir}`;
    console.log(`  daemon    ✓ ${daemonUrl}  ${brain}`);
  }

  // 2. wire each detected tool's MCP config (point it at this daemon)
  const launch: LaunchInfo = {
    command: process.execPath,
    args: [MCP_BIN],
    env: {
      MEMWARDEN_URL: daemonUrl,
      ...(secret ? { MEMWARDEN_SECRET: secret } : {}),
    },
  };
  const targets = all ? TOOLS : TOOLS.filter((t) => t.detect(home));

  console.log("");
  if (targets.length === 0) {
    console.log(
      "  no supported tools detected. Re-run with --all to wire them all anyway.",
    );
  } else {
    console.log(`  wiring ${targets.length} tool(s):`);
    for (const t of targets) {
      const r = writeTool(t, home, launch);
      if (r.status === "skipped") {
        console.log(`    - ${t.label.padEnd(13)} skipped (${r.reason})`);
        continue;
      }
      // Claude Code also gets real hooks: SessionStart auto-inject +
      // PostToolUse auto-capture (true automatic memory, no agent needed).
      let how = "agent recalls/saves via MCP + AGENTS.md";
      if (t.id === "claude-code") {
        writeClaudeHooks(join(home, ".claude", "settings.json"), HOOK_BASE);
        how = "hooks — auto inject + auto capture";
      }
      console.log(`    ✓ ${t.label.padEnd(13)} ${r.path}`);
      console.log(`      ${" ".repeat(13)} ${how}`);
    }
  }

  // 3. AGENTS.md in this project: tells the hook-less tools to use memory
  //    at task boundaries (the cross-tool auto-recall lever).
  const agents = writeAgentsMd(process.cwd());
  console.log("");
  console.log(
    `  AGENTS.md ✓ ${agents.created ? "wrote" : "updated"} ${agents.path}`,
  );

  console.log(
    `\n  Done. Restart each tool once so it loads the memwarden MCP server.\n` +
      `  Recall in any tool: type /recall, or just ask. Claude Code captures\n` +
      `  and recalls automatically; for global auto-capture on other tools,\n` +
      `  point them at the memory proxy (see README).\n`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "up":
      return up(rest);
    case "connect":
      return connect(rest);
    case "hook":
      return hook(rest);
    case "doctor":
      return doctor(rest);
    case "export":
      return exportBrain(rest[0]);
    case "import":
      return importBrain(rest[0]);
    default:
      console.log(
        "usage:\n" +
          "  memwarden up [--all] [--url URL] [--secret S]   # start daemon + wire every installed tool\n" +
          "  memwarden connect [claude-code|cursor|cline|windsurf] [--with-hooks] [--url URL] [--secret S]\n" +
          "  memwarden doctor [path]\n" +
          "  memwarden export <file>\n" +
          "  memwarden import <file>",
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`[memwarden] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
