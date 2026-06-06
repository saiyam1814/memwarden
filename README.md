# memwarden

**One brain. Every agent. Yours.**

A local-first, self-custodied memory layer for AI coding agents. Agents propose memories;
memwarden verifies them (evidence rules + multi-vendor model debate), signs them, invalidates
them when the code changes, and packs them into context under a hard token budget. Your memory
lives in a portable, signed, optionally encrypted **Brain Bundle** you can move between Claude
Code, Codex, Cursor, devices, and vendors.

> **Status: private build phase.** Not announced, not for distribution.

## Why

Every coding agent now remembers things; none of them verify what they remember, and every
vendor's memory is their lock-in. memwarden is the trust + portability layer: verified memory
that belongs to the user.

## Quick start (dev)

```bash
npm install
npm test          # 96 tests: kernel, store parity, oplog integrity, e2e
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

Read **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** for the full walkthrough: the kernel,
the state layer, the oplog hash chain, the write/read paths, and what each build phase adds.

## Layout

```
src/kernel/      in-process runtime: function registry, trigger dispatch, cron, pubsub, HTTP
src/state/       StateKV (5-method contract), memory + libSQL stores, append-only oplog
src/functions/   observe / search (BM25 + RRF) / context, and their supporting utilities
src/triggers/    REST API routes + auth middleware
test/            96 tests: unit, store parity, oplog tamper detection, end-to-end
docs/            architecture and how-it-works
```

## License

Apache-2.0
