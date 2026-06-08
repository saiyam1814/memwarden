#!/usr/bin/env node
//
// memwarden CLI. Today: `connect` wires the daemon into MCP clients.
//
//   memwarden connect              # writes ./.mcp.json for this project
//   memwarden connect cursor       # same config, named for the tool
//   memwarden connect --url http://localhost:3111 --secret <s>
//
// Any MCP client that reads .mcp.json then shares the one local brain.

import { writeMcpConfig, mcpConfigPathFor, buildMcpServerEntry } from "./connect.js";

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

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "connect") {
    console.log("usage: memwarden connect [claude-code|cursor|cline|windsurf] [--url URL] [--secret S]");
    process.exit(cmd ? 1 : 0);
  }
  const { target, url, secret } = parseFlags(rest);
  const opts = { ...(url ? { url } : {}), ...(secret ? { secret } : {}) };
  const path = mcpConfigPathFor(target, process.cwd());
  const { created } = writeMcpConfig(path, opts);

  console.log(
    `[memwarden] ${created ? "wrote" : "updated"} ${path} — '${target}' now shares the local brain.`,
  );
  console.log(`[memwarden] Universal MCP block for any other tool:\n`);
  console.log(
    JSON.stringify(
      { mcpServers: { memwarden: buildMcpServerEntry(opts) } },
      null,
      2,
    ),
  );
}

main();
