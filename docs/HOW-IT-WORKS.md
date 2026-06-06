# How memwarden works

A plain-English walkthrough of what exists in the repo today, how data flows through it,
and what each upcoming phase adds. Written for maintainers, no prior context assumed.

---

## 1. The big picture

memwarden is a small local daemon. Coding agents (Claude Code, Codex, Cursor, anything that
can call HTTP or MCP) send it observations about your work; it stores them as memories,
and when an agent starts working it asks memwarden for the relevant memories back, packed
to fit a token budget.

What will make it different from every other memory tool (built across the phases below):

1. **Trust** — memories get verified before they're believed: evidence rules, multi-vendor
   model debate on conflicts, signatures, and invalidation when the code changes.
2. **Token economy** — internals run on the cheapest adequate model, context is packed under
   a hard budget, and savings are measured (a cost ledger), never estimated.
3. **Self-custody** — your memory is a portable artifact (the Brain Bundle) you can move
   between agents, machines, and vendors. It belongs to you.

```
   agents ──observe──▶ ┌───────────────┐ ──context/search──▶ agents
                       │   memwarden    │
                       │  (local daemon)│
                       └──────┬────────┘
                              ▼
                    .brain bundle on disk
              (oplog + facts + indexes, yours)
```

## 2. What exists today (Phase 0)

Three layers, bottom to top:

### 2.1 The kernel (`src/kernel/`)

An in-process runtime, ~400 lines at its core. Everything in memwarden is a **function**
registered in a Map (`mem::observe`, `mem::search`, ...). The single entrypoint is
`trigger(functionId, payload)`:

- built-in ids are routed first (`state::get/set/update/delete/list` go to the store),
- app functions are looked up in the registry,
- unknown ids throw a structured `TriggerError`,
- "Void" triggers are fire-and-forget: they never crash the caller.

The kernel also provides: event subscriptions (`on`/`registerTrigger`), cron scheduling
(setInterval with jitter), in-process pubsub, a metrics shim (`getMeter`), and an HTTP
front door (`src/kernel/http.ts`, node:http) that maps REST routes to registered functions
through a middleware chain (auth, CORS, JSON parsing).

Why it matters: there is **no external engine and no sidecar**. One process, one binary
eventually. If the daemon is running, everything works.

### 2.2 The state layer (`src/state/`)

- **StateKV** (`kv.ts`): the only way anything touches storage. Five methods:
  `get / set / update / delete / list`, addressed by `(scope, key)`. Single chokepoint:
  every call flows through the kernel's `trigger`, which is what later phases hook for
  verification and cost accounting.
- **Two interchangeable stores** behind one interface:
  - `store-memory.ts` — a Map, used for tests and ephemeral runs,
  - `store-libsql.ts` — SQLite-family file database (libSQL), the real store.
  A 40-step parity suite asserts the two behave **byte-identically** (same misses, same
  overwrite semantics, same list ordering), so anything proven against one holds for the other.
- **The oplog** (`oplog.ts`): an append-only log of every mutation. Each row carries a
  sha256 hash chaining to the previous row, so tampering is detectable, and **replaying
  the log reproduces the exact KV state** (tested). This is the seed of the Brain Bundle:
  your memory is fundamentally a signed, replayable event log, and everything else
  (tables, indexes) is derived state that can be rebuilt from it.

### 2.3 The functions (`src/functions/`) and API (`src/triggers/`)

The write path:

```
POST /memwarden/observe
  → validate + normalize (privacy filters, dedup, modality tagging)
  → compress (zero-LLM synthetic path today; model-based compression is a later phase)
  → StateKV write (under a keyed lock so concurrent writes to a session don't race)
  → oplog append (hash-chained)
```

The read paths:

```
GET /memwarden/search?q=...
  → BM25 keyword scoring (k1=1.2, b=0.75) over the search index
  → RRF fusion (K=60) merges ranked streams: keyword 0.4 / vector 0.6 / graph 0.3
    (vector and graph streams are empty in Phase 0; weights renormalize over
     the streams that actually returned hits, so BM25 carries everything today)

GET /memwarden/context?project=...
  → collect candidate memories
  → pack newest-first until the token budget (default 2000) is full
    (recency packing is a placeholder: the budget governor in Phase 3 replaces it
     with relevance-aware selection under the same hard ceiling)
```

Auth: if `MEMWARDEN_SECRET` is set, every route (except `/livez`) requires it via a
timing-safe comparison; unset means open, for local dev.

## 3. What each phase adds

| Phase | What lands | What it unlocks |
|---|---|---|
| **0b** (next) | Vector index (LanceDB) behind an abstraction; Ed25519 signing on the oplog; the `.brain/` Bundle layout (export / import / replay); cost-ledger table; 100k-memory benchmark | Real semantic search; the portable signed Bundle; measured perf |
| **1** | `lint` (fast deterministic checks + autofix on CLAUDE.md-style files), `verify` (multi-vendor model debate with live confidence), signed verification manifest + CI drift gate, SPEC.md + format importers | The public wedge: the 30-second demo, the first release |
| **2** | The write gate: typed proposals (repo-fact / preference / habit / tool-result / external claim), per-type evidence rules, verdicts (store / reject / quarantine / supersede / needs-verification), NLI contradiction pre-filter, `why` / `diff` / `rollback` | Trust becomes enforced, not advisory |
| **3** | Proactive staleness invalidation from git events (renames, deletions, dep bumps, failing tests), budget governor (relevance-aware packing under a hard ceiling), compression tiers, viewer dashboard | Memories stop going confidently wrong; tokens provably drop |
| **4** | E2E-encrypted sync of the oplog through a content-blind relay; phone companion (read-only first) | Laptop ↔ phone, same brain, vendor can't read it |
| **5** | The evaluation harness + paper (pre-registered, objective metrics) | Credibility: measured claims, not marketing |

## 4. Key invariants (the rules everything must keep)

1. **Single chokepoint**: all storage flows through StateKV → `trigger`. No side doors.
2. **The oplog is append-only and hash-chained**; derived state must always be rebuildable
   from it (this is what makes the Bundle portable and sync possible).
3. **Store parity**: memory and libSQL stores stay byte-identical in observable behavior.
4. **Wire stability**: the `/memwarden/*` route shapes are the compatibility surface for
   connectors; change them deliberately or not at all.
5. **Measured, never modeled**: any savings or accuracy number we ever publish comes from
   recorded data (the cost ledger, the benchmark harness), not estimates.
6. **Constants are load-bearing**: RRF_K=60, stream weights 0.4/0.6/0.3, BM25 k1=1.2 b=0.75
   are tuned values; changing them requires benchmark evidence.

## 5. Running and poking at it

```bash
npm install && npm test            # full suite (96 tests)
npm run dev                        # kernel + REST on :3111

# write a memory
curl -X POST localhost:3111/memwarden/observe \
  -H 'content-type: application/json' \
  -d '{"sessionId":"s1","project":"demo","content":"deploy uses blue-green via ship.yaml"}'

# find it
curl 'localhost:3111/memwarden/search?q=deploy'

# get packed context for an agent session
curl 'localhost:3111/memwarden/context?project=demo'
```

Useful env vars: `MEMWARDEN_TOKEN_BUDGET` (default 2000), `MEMWARDEN_SECRET` (auth),
`MEMWARDEN_AGENT_ID`, `MEMWARDEN_SLOTS`, `MEMWARDEN_AUTO_COMPRESS`.
