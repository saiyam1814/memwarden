# memwarden

**The unified memory layer for AI agents — remembers, verifies, and cuts tokens.**

A local-first, self-custodied memory layer for AI coding agents. One local daemon holds
your memory; every agent (Claude Code, Codex, Cursor, …) shares it over MCP, so switching
tools never loses context. Memories are compressed with TurboQuant, stored in a
tamper-evident hash-chained log you can verify, and packed back into context under a hard
token budget — so recall is fast and costs fewer tokens, not more.

> **Status: private build phase.** Not announced, not for distribution.

## Why

Every coding agent now remembers things; none of them verify what they remember, and every
vendor's memory is their lock-in. memwarden is the trust + portability layer: verified memory
that belongs to the user.

## Quick start

```bash
npm install
npm run build           # compile to dist/
npm run dev             # start the daemon + REST API on :3111
```

Wire it into your coding agent so every tool shares the one local brain:

```bash
# from your project directory:
node dist/cli/bin.js connect claude-code --with-hooks
```

That writes two files in the project:

- **`.mcp.json`** — the MCP server, giving the agent the `memory_resume`,
  `memory_search`, `memory_remember`, `memory_verify`, and `memory_stats`
  tools. The same block works for Cursor, Cline, Windsurf, and any MCP client.
- **`.claude/settings.json`** — a `SessionStart` hook that auto-injects this
  project's memory the moment you open the agent, and a `PostToolUse` hook
  that captures work automatically.

Now switch from one agent to another in the same repo and just ask *"what
were we working on here?"* — it already knows. Embeddings run on-device
(`all-MiniLM-L6-v2`, ~23MB, downloaded once, no API key); set
`MEMWARDEN_EMBEDDING_PROVIDER=none` for keyword-only mode.

Move your memory between machines with the portable Brain Bundle:

```bash
node dist/cli/bin.js export brain.json     # on machine A
node dist/cli/bin.js import brain.json     # on machine B
```

> Pre-publish, run the CLI as `node dist/cli/bin.js …`. Once published it
> becomes `npx @memwarden/mcp` / a global `memwarden` command.

## How it works

An agent posts what it sees to `observe`; memwarden compresses it, stores it in a
libSQL key-value store, and appends a SHA-256 **hash-chained oplog** entry so the
store is tamper-evident. `search` ranks memories with a hybrid of BM25 keywords and
a **TurboQuant-compressed** vector index; `context` packs the most relevant memory
into a block under a token budget. Everything runs through one in-process kernel and
a small REST API, so any MCP client can share the same local brain.

## Layout

```
src/kernel/      in-process runtime: function registry, trigger dispatch, pubsub, HTTP
src/state/       StateKV (5-method contract), memory + libSQL stores, append-only oplog
src/functions/   observe / search (BM25 + TurboQuant vector + RRF) / context
src/embedding/   on-device embedding provider (transformers.js, optional)
src/mcp/         dependency-free MCP server (stdio JSON-RPC)
src/cli/         `memwarden connect` — wire any MCP client to the local brain
src/triggers/    REST API routes + auth middleware
test/            unit, store parity, oplog tamper detection, MCP, end-to-end
```

## License

Apache-2.0
