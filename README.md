<div align="center">

# 🧠 memwarden

### The unified memory layer for AI agents — remembers, verifies, and cuts tokens.

One local daemon holds your memory. Every agent — Claude Code, Codex, Cursor — shares it.
Switch tools mid-task and the next one already knows what you were doing.

`local-first` · `cross-agent` · `TurboQuant-compressed` · `tamper-evident` · `MCP + hooks` · `no API key`

</div>

---

## Why

Every coding agent forgets everything the moment the session ends. You re-explain the
architecture, re-teach your preferences, re-discover the same bug — in every tool, every day.
`CLAUDE.md` and `.cursorrules` cap out and go stale, and each vendor's memory is their lock-in.

**memwarden is the memory that follows you across agents, costs fewer tokens to recall, and
that you actually own.** It captures what your agent does, compresses it on-device, stores it
in a tamper-evident log you can verify, and feeds the right slice back — automatically, the
moment you open the next tool.

## The numbers

Measured on this machine with the real on-device model (`all-MiniLM-L6-v2`), 30 coding
memories, 14 **paraphrased** queries (worded differently than the answers). Reproduce with
`npm run benchmark`:

| Retrieval (gold answer in top-k) | R@5 | R@10 |
| --- | --- | --- |
| Full-precision vectors | 100% | 100% |
| **TurboQuant (4-bit, compressed)** | **100%** | **100%** |
| Keyword search (lexical baseline) | 71% | 79% |

- **Compression costs zero recall** — TurboQuant matches full-precision exactly.
- **Meaning beats keywords by ~25 points** — paraphrased questions that share no words with
  the answer still resolve.
- **5.9× smaller** vectors (384-dim @ 4-bit; ~11× at 2-bit), **~1ms** per search.

> The 100% figures are on a small, clean corpus — the point is that compression is free
> (quantized == full-precision) and semantic recall clearly beats lexical. Larger/noisier
> corpora land below 100%, but the *relationship* holds.

## Quick start

```bash
npm install
npm run build            # compile to dist/
npm run dev              # start the daemon + REST API on :3111
```

Wire it into your agent so every tool shares the one local brain — run this **from your
project directory**:

```bash
node dist/cli/bin.js connect claude-code --with-hooks
```

That writes two files:

- **`.mcp.json`** — gives the agent the `memory_resume`, `memory_search`, `memory_remember`,
  `memory_verify`, and `memory_stats` tools. The same block works for Cursor, Cline, Windsurf,
  and any MCP client.
- **`.claude/settings.json`** — a `SessionStart` hook that auto-injects this project's memory
  the moment you open the agent, plus a `PostToolUse` hook that captures work as it happens.

Then switch agents in the same repo and just ask *"what were we working on here?"* — it
already knows.

## How it works

```
  your agent  ──observe──▶  compress (synthetic)  ──▶  libSQL store + hash-chained oplog
                                                              │
   MiniLM embed ──▶ TurboQuant 4-bit codes ──▶ vector index  │  (tamper-evident)
                                                              ▼
  your agent  ◀──resume / search──  BM25 + vector (RRF), packed under a token budget
```

1. **Capture** — `observe` compresses raw tool output into a compact record (zero-LLM).
2. **Embed + compress** — text → `all-MiniLM-L6-v2` vector → **TurboQuant** 2/4-bit codes
   (Google's quantization algorithm, [arXiv:2504.19874](https://arxiv.org/abs/2504.19874),
   implemented from scratch in pure TypeScript).
3. **Store + chain** — every write lands in a SHA-256 hash-chained oplog, so the store is
   tamper-evident and `memory_verify` can prove it.
4. **Recall** — hybrid BM25 + vector search, scoped to your project, packed back into context
   under a hard token budget.

## What makes it different

| | memwarden | typical agent memory |
| --- | --- | --- |
| Cross-agent (one brain, every tool) | ✅ MCP + hooks | varies |
| Compressed storage | ✅ TurboQuant, ~6–11× | usually raw float32 |
| Tamper-evident | ✅ hash-chained oplog + `memory_verify` | ✗ |
| Portable, self-owned | ✅ `export`/`import` Brain Bundle | often vendor-locked |
| Runtime dependencies | **2** (libSQL, zod); embeddings + MCP add nothing native | heavier |
| Token economy + latency, measured | ✅ live in `/stats` | rarely |

## MCP tools

| Tool | What it does |
| --- | --- |
| `memory_resume` | Recall what was worked on in this project, across all past sessions and agents |
| `memory_search` | Hybrid semantic + keyword search |
| `memory_remember` | Save a memory explicitly |
| `memory_verify` | Cryptographically verify the store wasn't tampered with |
| `memory_stats` | Live counts, compression ratio, token reduction, latency |

## Portability

```bash
node dist/cli/bin.js export brain.json     # on machine A
node dist/cli/bin.js import brain.json     # on machine B
```

Your memory is a portable JSON bundle. No vendor in the loop.

## Layout

```
src/kernel/      in-process runtime: function registry, trigger dispatch, pubsub, HTTP
src/state/       StateKV, memory + libSQL stores, append-only hash-chained oplog
src/functions/   observe / search (BM25 + TurboQuant vector + RRF) / context / forget
src/embedding/   on-device embedding provider (transformers.js, optional)
src/mcp/         dependency-free MCP server (stdio JSON-RPC)
src/cli/         connect / hooks / export / import
src/bundle/      portable Brain Bundle export & import
src/observability/  token-reduction + latency metrics
benchmark/       reproducible recall benchmark
test/            171 tests: kernel, store parity, oplog, quantizer, MCP, e2e
```

## Configuration

| Env | Default | Purpose |
| --- | --- | --- |
| `MEMWARDEN_EMBEDDING_PROVIDER` | `local` | `local` (on-device MiniLM) or `none` (keyword-only) |
| `MEMWARDEN_QUANT_VECTOR` | follows embeddings | force TurboQuant on/off |
| `MEMWARDEN_QUANT_BITS` | `4` | `2` or `4` bits per dimension |
| `MEMWARDEN_FORGET_TTL_DAYS` | `30` | retention window for the forget sweep |
| `MEMWARDEN_SECRET` | unset | bearer token for the REST API |

## Roadmap

Tamper-*evidence* ships today (hash chain); **Ed25519 signing** of the oplog and
**encrypted** Brain Bundles are next, followed by multi-model verification of proposed
memories and an ANN index for >1M-memory scale.

## License

Apache-2.0
