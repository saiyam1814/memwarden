#!/usr/bin/env node
//
// memwarden MCP server entrypoint. Speaks JSON-RPC over stdio and proxies
// to a running memwarden daemon. Point any MCP client at this:
//
//   { "command": "npx", "args": ["-y", "@memwarden/mcp"],
//     "env": { "MEMWARDEN_URL": "http://localhost:3111" } }

import { createMcpServer, runStdio } from "./server.js";

const baseUrl = process.env.MEMWARDEN_URL ?? "http://localhost:3111";
const secret = process.env.MEMWARDEN_SECRET;

const server = createMcpServer(
  secret ? { baseUrl, secret } : { baseUrl },
);
runStdio(server);
