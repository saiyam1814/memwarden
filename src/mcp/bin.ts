#!/usr/bin/env node
//
// memwarden MCP server entrypoint. Speaks JSON-RPC over stdio and proxies
// to a running memwarden daemon. Point any MCP client at this:
//
//   { "command": "npx", "args": ["-y", "@memwarden/mcp"],
//     "env": { "MEMWARDEN_URL": "http://localhost:3111" } }

import { createMcpServer, runStdio } from "./server.js";
import { ensureDaemon } from "../daemon/ensure.js";
import { getSecret } from "../functions/config.js";

const baseUrl = process.env.MEMWARDEN_URL ?? "http://localhost:3111";
// Resolve env first, then the persisted <dataDir>/secret file, so a server
// launched without the env var still authenticates to a secured daemon.
const secret = getSecret();

// Self-heal: revive the daemon on demand if a request finds it down.
const ensureUp = async (): Promise<void> => {
  await ensureDaemon(baseUrl);
};

const server = createMcpServer({
  baseUrl,
  ensureUp,
  ...(secret ? { secret } : {}),
});

// Warm the daemon at startup so the first recall is instant, but never block
// the stdio handshake on it.
void ensureDaemon(baseUrl).catch(() => undefined);

runStdio(server);
