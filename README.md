<div align="center">

# 🧠 memwarden

### Memory your AI agents can trust. Verify it, audit what's stale, never touch it.

Every AI coding tool can share one local brain. The crowded part is making that happen;
memwarden does it, then goes further: it **proves the memory wasn't tampered with**, **audits
whether each memory is still safe to inject**, and **heals itself so you never touch it.** Works
across Claude Code, Codex, Cursor, Kiro, Antigravity, OpenCode, and OpenClaw.

`verifiable` · `staleness audit` · `self-healing` · `cross-tool` · `local-first` · `no API key`

</div>

---

## The problem

Every coding agent forgets the moment a session ends, so you re-explain the architecture,
re-teach preferences, and re-discover the same bug, in every tool, every day. The obvious fix
is shared memory across tools. But shared memory is only useful if you can trust it: a memory
that points at code you deleted, or that nothing backs up, is worse than none, because the
agent injects it with confidence.

## Why it's different

Most memory layers stop at "remember more." memwarden is built around **memory you can rely
on**:

- **`doctor` — is this memory still safe to inject?** Every memory carries provenance. The
  doctor flags `STALE` (references files that changed) and `UNSOURCED` (no evidence) memories.
  Auditing whether memory is still *true*, not just whether it exists, is the part nobody else
  leads with.
- **Verifiable.** Every write lands in a SHA-256 hash-chained oplog; `memory_verify` proves it
  was not tampered with.
- **Self-healing.** Once it is up you never touch it: it revives on use and restarts on crash
  and at login.
- **Compressed and yours.** TurboQuant 2/4-bit vectors (6–11× smaller, zero recall loss),
  on-device embeddings, two runtime dependencies, a portable bundle, no vendor.

The cross-tool reach below is table stakes. The trust layer is what makes it memwarden.

## Setup is one command

```bash
npm install
npm run build
node dist/cli/bin.js up
```

`memwarden up` is the whole thing. It:

- **starts a self-healing daemon** in the background (one global brain at `~/.memwarden`), and
  registers it as an OS service so it restarts on crash and starts at login,
- **detects your installed tools** and writes the memwarden MCP server into each one's config,
  in that tool's own schema, without clobbering servers you already have,
- **writes an `AGENTS.md`** block so tools without a hook system still recall and save
  automatically.

| Tool | What `up` writes | How memory flows |
| --- | --- | --- |
| **Claude Code** | `~/.claude.json` + `~/.claude/settings.json` hooks | mechanical (auto inject + auto capture) |
| **Codex** | `~/.codex/config.toml` | standing instruction + `/recall` |
| **Cursor** | `~/.cursor/mcp.json` | standing instruction + `/recall` |
| **Kiro** | `~/.kiro/settings/mcp.json` | standing instruction + `/recall` |
| **Antigravity** | `~/.gemini/config/mcp_config.json` | standing instruction + `/recall` |
| **OpenCode** | `~/.config/opencode/opencode.json` | standing instruction + `/recall` |
| **OpenClaw** | `~/.openclaw/openclaw.json` | standing instruction + `/recall` |

Restart each tool once so it loads the new server. `memwarden down` removes the service.

## How memory crosses your tools

This is the honest mechanics, because it matters. There are exactly three ways memory reaches
a tool, and `memwarden up` wires whichever ones each tool supports:

1. **Hooks (Claude Code).** Mechanical. A `SessionStart` hook injects this project's memory
   before you type a word; a `PostToolUse` hook captures your work as it happens. The agent
   cannot forget to do it.
2. **Standing instruction (Codex, Cursor, Kiro, Antigravity, OpenCode, OpenClaw).** `up` writes
   an `AGENTS.md` block telling the agent to recall at the start of every task and to save what
   it learns. The agent does this itself, on every task, without you asking. This is the same
   mechanism every cross-tool memory layer uses for these tools: they expose no deeper hook, so
   "automatic" means a standing instruction the agent follows, backed by the `/recall` command
   when you want to force it.
3. **Proxy (any model-configurable tool, local or paid).** Mechanical at the API boundary.
   Point the tool's model base URL at the memwarden proxy and every turn is recalled and
   captured with no agent cooperation at all.

So: capture in Claude Code, then open Cursor or Codex and they pull up what Claude learned. On
Claude Code that handoff is mechanical; on the MCP tools the agent does it via the standing
instruction (or you type `/recall`); through the proxy it is mechanical for any model.

## Self-healing

Once it is up, you never touch it.

- **On use** — if the daemon is down, the next tool that launches the MCP server revives it
  automatically (it spawns the daemon and retries the request).
- **On crash or reboot** — the OS service (macOS LaunchAgent / Linux systemd `--user`) restarts
  it on failure and starts it at login.
- **Race-safe** — a second daemon on the same port exits cleanly instead of crash-looping.

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

> The 100% figures are on a small, clean corpus. The point is that compression is free
> (quantized == full-precision) and semantic recall beats lexical. Larger, noisier corpora
> land below 100%, but the relationship holds.

## How it works

```
  your tool  ──observe──▶  compress (on-device)  ──▶  libSQL store + hash-chained oplog
                                                            │
   MiniLM embed ──▶ TurboQuant 4-bit codes ──▶ vector index │  (tamper-evident)
                                                            ▼
  your tool  ◀──resume / recall──  BM25 + vector (RRF), packed under a token budget
```

1. **Capture.** `observe` compresses raw tool output into a compact record (no LLM call).
2. **Embed and compress.** text → `all-MiniLM-L6-v2` vector → **TurboQuant** 2/4-bit codes
   (Google's quantization algorithm, [arXiv:2504.19874](https://arxiv.org/abs/2504.19874),
   implemented from scratch in pure TypeScript).
3. **Store and chain.** Every write lands in a SHA-256 hash-chained oplog, so the store is
   tamper-evident and `memory_verify` can prove it.
4. **Recall.** Hybrid BM25 + vector search, scoped to your project by canonical path (symlinks
   and path spellings resolved, so recall never silently misses), packed under a token budget.

## `memwarden doctor` — memory you can trust

Recall is only half the job. The other half is knowing the memory is still safe to use. The
doctor audits your stored memories against the live repo:

```bash
node dist/cli/bin.js doctor .

  SAFE TO INJECT: 12 memories
  STALE:           2 memories reference files that changed
  UNSOURCED:       1 memory has no evidence

  [stale]  Edit — references 1 file(s) that no longer exist: src/legacy.ts
```

Every memory carries provenance (the files, command, and tool it came from). `STALE` means it
points at files that no longer exist; `UNSOURCED` means it has no evidence behind it; `SAFE`
means it is sourced and still valid.

## What makes it different

| | memwarden | typical agent memory |
| --- | --- | --- |
| One-command setup across every tool | ✅ `memwarden up` (7 tools) | manual, per tool |
| Self-healing daemon (use + crash + reboot) | ✅ | ✗ |
| Trust audit (stale / unsourced) | ✅ `memwarden doctor` | ✗ |
| Compressed storage | ✅ TurboQuant, ~6–11× | usually raw float32 |
| Tamper-evident | ✅ hash-chained oplog + `memory_verify` | ✗ |
| Portable, self-owned | ✅ `export` / `import` Brain Bundle | often vendor-locked |
| Runtime dependencies | **2** (libSQL, zod); embeddings + MCP add nothing native | heavier |

## MCP tools and the `/recall` command

| Tool | What it does |
| --- | --- |
| `memory_resume` | Recall what was worked on in this project, across all past sessions and tools |
| `memory_search` | Hybrid semantic + keyword search |
| `memory_remember` | Save a memory explicitly |
| `memory_verify` | Cryptographically verify the store was not tampered with |
| `memory_stats` | Live counts, compression ratio, token reduction, latency |

Plus an MCP **prompt**, `recall`, surfaced as a slash command (`/mcp__memwarden__recall <query>`
in Claude Code): type it mid-chat to pull this project's matching memory into the conversation.

## The proxy — one memory layer for local or paid models

An OpenAI-compatible gateway that any model-configurable tool can point its base URL at. It
injects relevant memory and captures the answer, and it is blind to the model behind it. Local
(Ollama, LM Studio) and paid (OpenAI, OpenRouter, Together) all speak the same
`/v1/chat/completions`, so it is one memory layer for all of them. Streaming (SSE) passes
straight through.

```bash
# paid upstream:
MEMWARDEN_UPSTREAM_URL=https://api.openai.com/v1 MEMWARDEN_UPSTREAM_KEY=sk-... node dist/index.js
# local model, no key:
MEMWARDEN_UPSTREAM_URL=http://localhost:11434/v1 node dist/index.js
# then point your tool's OpenAI base URL at:  http://localhost:3113/v1
```

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
src/functions/   observe / search (BM25 + TurboQuant vector + RRF) / doctor / context / forget
src/functions/paths.ts   canonical project/cwd scoping (recall never silently misses)
src/embedding/   on-device embedding provider (transformers.js, optional)
src/mcp/         dependency-free MCP server (stdio JSON-RPC) + the recall prompt
src/proxy/       OpenAI-compatible memory gateway (the universal cross-tool layer)
src/daemon/      ensure (self-heal on use) + service (self-heal on crash/reboot)
src/cli/         up / down / connect / doctor / hooks / export / import
src/cli/tools.ts per-tool adapters: Claude Code, Codex, Cursor, Kiro, Antigravity, OpenCode, OpenClaw
src/bundle/      portable Brain Bundle export & import
benchmark/       reproducible recall benchmark
test/            209 tests: kernel, store parity, oplog, quantizer, MCP, proxy, tool-wiring,
                 path scoping, self-heal, cross-tool reliability harness, e2e
```

## Configuration

| Env | Default | Purpose |
| --- | --- | --- |
| `MEMWARDEN_DATA_DIR` | `~/.memwarden` | where the brain lives |
| `MEMWARDEN_EMBEDDING_PROVIDER` | `local` | `local` (on-device MiniLM) or `none` (keyword-only) |
| `MEMWARDEN_QUANT_VECTOR` | follows embeddings | force TurboQuant on/off |
| `MEMWARDEN_QUANT_BITS` | `4` | `2` or `4` bits per dimension |
| `MEMWARDEN_FORGET_TTL_DAYS` | `30` | retention window for the forget sweep |
| `MEMWARDEN_SECRET` | unset | bearer token for the REST API |
| `MEMWARDEN_UPSTREAM_URL` | unset | upstream OpenAI-compatible base URL; enables the proxy |
| `MEMWARDEN_UPSTREAM_KEY` | unset | API key forwarded to the upstream (omit for local models) |
| `MEMWARDEN_PROXY_PORT` | `3113` | port the memory proxy listens on |

## Not built yet (so this README does not pretend otherwise)

Tamper-*evidence* ships today via the hash chain. Oplog *signing* (Ed25519), *encrypted* Brain
Bundles, and an ANN index for >1M-memory scale are not built. They are candidates, not claims.

## License

Apache-2.0
