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
import { writeMcpConfig, mcpConfigPathFor, buildMcpServerEntry } from "./connect.js";

const DAEMON_URL = process.env.MEMWARDEN_URL ?? "http://localhost:3111";

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
  const opts = { ...(url ? { url } : {}), ...(secret ? { secret } : {}) };
  const path = mcpConfigPathFor(target, process.cwd());
  const { created } = writeMcpConfig(path, opts);
  console.log(
    `[memwarden] ${created ? "wrote" : "updated"} ${path} — '${target}' now shares the local brain.`,
  );
  console.log(`[memwarden] Universal MCP block for any other tool:\n`);
  console.log(
    JSON.stringify({ mcpServers: { memwarden: buildMcpServerEntry(opts) } }, null, 2),
  );
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
    case "export":
      return exportBrain(rest[0]);
    case "import":
      return importBrain(rest[0]);
    default:
      console.log(
        "usage:\n" +
          "  memwarden connect [claude-code|cursor|cline|windsurf] [--url URL] [--secret S]\n" +
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
