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

## Quick start (dev)

```bash
npm install
npm test          # kernel, store parity, oplog integrity, MCP, e2e
npm run dev       # boots the kernel + REST API on :3111
```

```bash
curl -X POST localhost:3111/memwarden/observe \
  -H 'content-type: application/json' \
  -d '{"sessionId":"s1","project":"demo","content":"auth module uses iam, not authz"}'

curl 'localhost:3111/memwarden/search?q=auth'
curl 'localhost:3111/memwarden/context?project=demo'
```

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
