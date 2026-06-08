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

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  writeMcpConfig,
  mcpConfigPathFor,
  buildMcpServerEntry,
  writeClaudeHooks,
  claudeSettingsPathFor,
} from "./connect.js";
import { handleSessionStart, handleCapture, readStdin } from "./hook.js";

const DAEMON_URL = process.env.MEMWARDEN_URL ?? "http://localhost:3111";

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

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
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
