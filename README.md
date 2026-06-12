<div align="center">

# 🧠 memwarden

### The memory firewall for AI coding agents.

**Your agent's memory is lying to you. Prove yours isn't.**

memwarden is verified, self-custodied memory for AI coding agents. It is local-first,
dependency-light, and works across every tool you use — Claude Code, Codex, Cursor, Kiro,
Antigravity, OpenCode, OpenClaw. The point isn't to remember *more*. It's that nothing gets
injected into your agent's context without provenance that still checks out.

`memory firewall` · `verified recall` · `tamper-evident` · `self-custodied` · `cross-tool` · `no API key`

[![npm](https://img.shields.io/npm/v/memwarden?color=cb3837&label=npm&logo=npm)](https://www.npmjs.com/package/memwarden)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](package.json)

```bash
npx memwarden audit <your-memory-store>   # zero-install: audit what you already have
npm install -g memwarden && memwarden up   # persistent: wire every tool
```

</div>

---

## The problem: is the memory still true?

Most memory layers are built to *remember more.* memwarden is built around a harder question:
**is the memory still true?**

The failure mode that hurts isn't forgetting — it's **confidently wrong recall**. A stored fact
silently goes stale: it points at code you've since changed or deleted, and the agent injects it
with full confidence anyway. The industry has started naming this class of risk — OWASP added
Memory Poisoning (ASI06) to its 2026 Agentic Top 10 — yet memory still tends to store everything
and trust everything.

A memory that points at code you deleted, or that nothing backs up, is worse than no memory at
all — because the agent injects it with full confidence.

memwarden is built around the opposite default: **memory is untrusted until its source still
checks out.**

## Three reasons it exists

**1. Verified Recall — the anti-feature.** Memory is firewalled before it reaches a model.
A memory whose source file was deleted or changed since capture is `stale` and never injected.
Run `memwarden doctor` against any memory store and get a red/yellow/green audit of what's
verified, what's merely sourced, what's stale, and what has no provenance at all. It's a
shareable artifact you can point at your own existing memory and watch it light up yellow.

**2. Self-custodied and portable.** Your second brain shouldn't depend on a vendor's roadmap.
memwarden is local-first, tamper-evident, and portable: one `export` produces a Brain Bundle you
can move between machines or agents. Zero cloud. The data lives at `~/.memwarden` and nowhere else.

**3. The memory firewall.** Nothing enters your agent's context without provenance that still
holds. The unique lever — possible only for a coding-agent tool because the repo is ground
truth — is tying memory validity to **source-file content hashes**. The repo tells us, on every
recall, whether a memory is still earned.

## Source-file hashes: the ground truth

A coding agent has something general-purpose memory doesn't: the repository on disk is the source
of truth. When memwarden captures a code-backed memory, it records a SHA-256 content hash for
each referenced file (best-effort, files up to ~2 MB). On recall it re-hashes the live file and
compares. If the file is gone or its content moved, the memory is provably stale — not by
heuristic, by hash.

Tying memory validity to source-file content hashes is what lets the repo tell us, on every
recall, whether a memory is still earned.

## Verified Recall — what the four states mean

Every memory is classified against the live repo:

- **verified** — a captured source-file hash still matches the file on disk (code-backed and
  current).
- **sourced_unverified** — it has a source (a command, or files that were present but not
  hashable), but no content hash to re-check. Allowed, but not content-verified.
- **stale** — a referenced file was deleted, or its content changed since capture.
- **unsourced** — no provenance at all: no files, no command, not user-confirmed.

**The firewall drops `stale` before injecting. It does not drop `unsourced`** — unsourced means
*unverified*, not *dangerous*, so it stays available for explicit lookups. `memory_resume`, the
`/recall` prompt, the Claude Code SessionStart hook, and the proxy all run recall with the
firewall on. It scans a wide window to backfill lower-ranked safe results and warns (rather than
silently capping) if that window is exhausted. It also drops an older memory that a newer safe
memory contradicts, using conservative subject/value claims — no LLM, no fuzzy black box. Plain
`memory_search` stays unfiltered for deliberate lookups; the REST API refuses `safe_only` without
a `cwd` to verify against rather than pass memory through unchecked.

## The shareable audit: `memwarden doctor`

Point it at a repo and it runs the exact same check as a report, plus conservative conflict
detection:

```bash
node dist/cli/bin.js doctor .

  VERIFIED:        8 memories (code-backed, current)
  SOURCED:         3 memories (sourced, not content-verified)
  STALE:           2 memories reference files that changed/deleted
  UNSOURCED:       1 memory has no evidence
  CONFLICTS:       1 possible contradiction

  [stale]    Edit — references files that no longer match (changed: src/legacy.ts)
  [conflict] Edit may contradict Edit — same subject "auth" has incompatible values
```

This is the artifact. Run it against your current memory store and see how much of it is still
earned.

## Déjà Fix — never solve the same error twice, across every tool

memwarden is the one process that sees **every** agent's sessions on your machine, so it can do
something no per-tool memory can: when any agent (Claude Code, Codex, Cursor, …) resolves an
error, it captures `{error signature → root cause + fix}` with the same provenance file-hashes.
When **any** agent later hits a matching error, the verified fix is surfaced automatically —
but only if its referenced files still hash-match. A stale fix is never surfaced.

```bash
# Codex solved a failing test yesterday. Today Claude Code hits the same failure:
#   Déjà Fix (memwarden): this error was solved by codex on 2026-06-09 and the fix
#   is verified current against your working tree.
#   Root cause: clock skew  ·  Fix: mock NTP in conftest

# scriptable too — pipe any failing command's output straight in:
npm test 2>&1 | node dist/cli/bin.js dejafix lookup
```

Three properties, all load-bearing: it is **cross-agent** (a fix learned in Codex helps Claude
Code), **project-scoped** (a fix never leaks across repos), and **safe by construction** — it
reuses Verified Recall, so file drift or deletion auto-suppresses the fix. The hook auto-injects
only `verified current` fixes; `sourced, unverified` ones stay available via `dejafix lookup`,
`/recall`, and the `dejafix_lookup` MCP tool but are never silently pushed into your context.

## Tamper-evident, honestly

Every write lands in an append-only, SHA-256 hash-chained oplog. `memory_verify` walks the chain
and recomputes every hash, so an **edit or a reorder** of any past entry breaks the chain at the
first touched entry.

It is **tamper-evident, not tamper-proof.** There is no signing. The chain detects edits and
reorders, but it does **not** detect tail-truncation — dropping the newest entries leaves a
shorter, still-valid chain. We say "tamper-evident" and mean exactly that.

**Deletion comes with a receipt.** `memwarden forget <id>` removes a memory from the store and
every index, and prints a receipt citing the oplog entries that recorded the original write and
the deletion, plus whole-chain verification — proof the delete actually happened, without
re-disclosing the deleted content. An unknown id reports failure honestly; there is no
`{deleted: 0, success: true}` theater here.

## Start here: audit the memory you already have

You don't have to install anything or trust any claim — point the auditor at the memory store
you already use and the repo it talks about:

```bash
npx memwarden audit ~/.claude-mem/claude-mem.db --root ~/code/my-repo   # claude-mem (any SQLite store)
npx memwarden audit CLAUDE.md                                           # a CLAUDE.md / AGENTS.md / rules pile
npx memwarden audit mem0-export.json --root ~/code/my-repo              # a Mem0-style JSON export
```

No daemon, no setup, read-only (SQLite stores are copied before opening). The report classifies
every memory: **MISSING** (red — references files that no longer exist), **DRIFTED** (yellow —
files changed after the memory was recorded, when the store has timestamps), **PRESENT** (files
exist — which is the strongest claim a store without content hashes can make), **UNANCHORED**
(no file evidence at all). Every red and yellow memory is one your agent would have injected
with full confidence.

Add `--html [out.html]` for a self-contained, shareable report page (no external assets — safe to
open, attach, or screenshot), or `--json` for the raw data:

```bash
npx memwarden audit ~/.claude-mem/claude-mem.db --root ~/code/my-repo --html audit.html
```

## Setup is one command

```bash
npm install -g memwarden
memwarden up
```

`up` wires long-lived hooks, MCP servers, and a self-healing daemon, so it needs a stable
install — a global install (above) or a project-local one. Running it straight from `npx`'s
transient cache is refused with a pointer here, because npm later deletes that cache and the
wiring would break. (The zero-install `npx memwarden audit <store>` needs none of this. From a
checkout: `npm install && npm run build && node dist/cli/bin.js up`.)

`memwarden up` is the whole thing. It:

- **starts a self-healing daemon** in the background (one global brain at `~/.memwarden`) and
  registers it as an OS service (macOS LaunchAgent / Linux systemd `--user`) so it restarts on
  crash and starts at login,
- **detects your installed tools** and writes the memwarden MCP server into each one's config,
  in that tool's own schema, without clobbering servers you already have,
- **writes an `AGENTS.md`** block so tools without a hook system still recall and save on every
  task.

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

**You stay in charge of the automatic paths.** `MEMWARDEN_INJECT=off` starts sessions with a
clean slate (no auto-injection anywhere — explicit `/recall` and the MCP tools still work);
`MEMWARDEN_CAPTURE=off` stops auto-capture. `memwarden exclude <path>` firewalls a project
completely — no capture from it, no injection into it, across hooks and proxy alike, effective
immediately (the list is re-read per request, so there is no "excluded but still summarized"
failure mode). `memwarden include <path>` undoes it; `memwarden exclude --list` shows the list.

## How memory crosses your tools

Cross-tool reach is table stakes — the trust layer above is the point. Still, the mechanics
matter, so here they are honestly. There are exactly three ways memory reaches a tool, and
`memwarden up` wires whichever ones each tool supports:

1. **Hooks (Claude Code).** Mechanical. A `SessionStart` hook injects this project's verified
   memory before you type a word; a `PostToolUse` hook captures your work as it happens. The
   agent cannot forget to do it.
2. **Standing instruction (Codex, Cursor, Kiro, Antigravity, OpenCode, OpenClaw).** `up` writes
   an `AGENTS.md` block telling the agent to recall at the start of every task and save what it
   learns. This is the same mechanism every cross-tool memory layer uses for these tools: they
   expose no deeper hook, so "automatic" means a standing instruction the agent follows, backed
   by the `/recall` command when you want to force it.
3. **Proxy (model-configurable tools).** Mechanical at the API boundary, but only where you
   control the model endpoint — OpenCode, OpenClaw, Ollama, LM Studio, or any custom OpenAI base
   URL. Point the tool's base URL at the memwarden proxy on `:3113` and every turn is recalled
   and captured with no agent cooperation. It does **not** intercept Claude Code (own protocol —
   covered by hooks) or Cursor/Kiro/Antigravity (their own backends).

So: capture in Claude Code, then open Cursor or Codex and they pull up what Claude learned. On
Claude Code that handoff is mechanical via hooks; on the MCP tools the agent does it via the
standing instruction (or you type `/recall`); through the proxy it is mechanical for any model
endpoint you control.

## The 60-second trust demo

Run the product thesis locally without starting a daemon:

```bash
npm run demo:trust
```

It creates a temp repo, captures a code-backed memory, changes the file, and proves `safe_only`
recall refuses the now-stale memory while plain search can still find it. Then it captures two
sourced claims (`runtime uses node 22` / `runtime uses bun runtime`), proves safe recall keeps
**both** (it never silently drops a true fact), and shows `memwarden doctor` flagging the
contradiction as an advisory.

## Self-healing

Once it is up, you never touch it.

- **On use** — if the daemon is down, the next tool that launches the MCP server revives it
  automatically (it spawns the daemon and retries the request).
- **On crash or reboot** — the OS service (macOS LaunchAgent / Linux systemd `--user`) restarts
  it on failure and starts it at login.
- **Race-safe** — a second daemon on the same port exits cleanly instead of crash-looping.

## How it works

```
  your tool  ──observe──▶  compress (on-device)  ──▶  libSQL store + hash-chained oplog
                                                            │
   MiniLM embed ──▶ TurboQuant 4-bit codes ──▶ vector index │  (tamper-evident)
                                                            ▼
  your tool  ◀──verified recall──  BM25 + vector (RRF), firewalled, packed under a token budget
```

1. **Capture.** `observe` compresses raw tool output into a compact record (no LLM call), and
   hashes the source files it references.
2. **Embed and compress.** text → `all-MiniLM-L6-v2` vector → **TurboQuant** 2/4-bit codes
   (Google's quantization algorithm, [arXiv:2504.19874](https://arxiv.org/abs/2504.19874),
   implemented from scratch in pure TypeScript).
3. **Store and chain.** Every write lands in the SHA-256 hash-chained oplog, so the store is
   tamper-evident and `memory_verify` can confirm the chain is intact.
4. **Verified recall.** Hybrid BM25 + vector search (RRF), scoped to your project by canonical
   path (symlinks and path spellings resolved, so recall never silently misses), firewalled so
   stale memory never reaches the model, packed under a token budget. (Contradictions are
   surfaced by `doctor` as advisories — recall never silently drops a true memory.)

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

## What it does

| Capability | How |
| --- | --- |
| Memory firewall — stale memory never injected | Verified Recall (`safe_only`) |
| Trust audit — stale / unsourced / conflicts | `memwarden doctor` |
| Validity tied to source-file content | per-file SHA-256, re-checked on recall |
| Tamper-evident store | hash-chained oplog + `memory_verify` |
| One-command setup across every tool | `memwarden up` (7 tools) |
| Self-healing daemon (use + crash + reboot) | LaunchAgent / systemd + revive-on-use |
| Self-custodied, portable | `export` / `import` Brain Bundle, zero cloud |
| Compressed storage | TurboQuant, ~6–11× smaller |
| Lean footprint | 2 runtime deps (libSQL, zod); embeddings + MCP add nothing native |

## MCP tools and the `/recall` command

| Tool | What it does |
| --- | --- |
| `memory_resume` | Verified recall of what was worked on in this project, across all past sessions and tools |
| `memory_search` | Hybrid semantic + keyword search (unfiltered, for explicit lookups) |
| `memory_remember` | Save a memory explicitly |
| `memory_verify` | Confirm the oplog hash chain is intact (tamper-evident; not signed) |
| `memory_stats` | Live counts, compression ratio, token reduction, latency |

Plus an MCP **prompt**, `recall`, surfaced as a slash command (`/mcp__memwarden__recall <query>`
in Claude Code): type it mid-chat to pull this project's matching, verified memory into the
conversation.

## The proxy — one memory layer for the models you control

An OpenAI-compatible gateway on `:3113` that any model-configurable tool can point its base URL
at. It injects relevant verified memory, captures the answer, and is blind to the model behind
it. Local (Ollama, LM Studio) and paid (OpenAI, OpenRouter, Together) all speak the same
`/v1/chat/completions`, so it is one memory layer for all of them. Streaming (SSE) passes
straight through. It applies only where you control the model endpoint — tools with their own
protocol or backend (Claude Code, Cursor, Kiro, Antigravity) are covered by hooks or the
standing instruction instead.

```bash
# paid upstream:
MEMWARDEN_UPSTREAM_URL=https://api.openai.com/v1 MEMWARDEN_UPSTREAM_KEY=sk-... node dist/index.js
# local model, no key:
MEMWARDEN_UPSTREAM_URL=http://localhost:11434/v1 node dist/index.js
# then point your tool's OpenAI base URL at:  http://localhost:3113/v1
```

When the install has a secret (`memwarden up` generates one), the proxy requires it from
clients too: set your tool's API key to the secret (`cat ~/.memwarden/secret`). The proxy
strips it before forwarding, so it never reaches the upstream. Without this, any local
process could spend your upstream key and poison capture.

## Portability — your memory survives the next pivot

```bash
node dist/cli/bin.js export brain.json     # on machine A
node dist/cli/bin.js import brain.json     # on machine B
```

Your memory is a portable JSON Brain Bundle. No cloud, no vendor in the loop. When the next
memory startup gets acquired or sunset, you keep your brain.

## Layout

```
src/kernel/      in-process runtime: function registry, trigger dispatch, pubsub, HTTP
src/state/       StateKV, memory + libSQL stores, append-only hash-chained oplog
src/functions/   observe / search (BM25 + TurboQuant vector + RRF) / doctor / conflicts / dejafix / context / forget
src/functions/verify.ts  Verified Recall: content-hash provenance -> verified / sourced_unverified / stale / unsourced
src/functions/paths.ts   canonical project/cwd scoping (recall never silently misses)
src/embedding/   on-device embedding provider (transformers.js, optional)
src/mcp/         dependency-free MCP server (stdio JSON-RPC) + the recall prompt
src/proxy/       OpenAI-compatible memory gateway (for model endpoints you control)
src/daemon/      ensure (self-heal on use) + service (self-heal on crash/reboot)
src/cli/         up / down / connect / doctor / audit / forget / exclude / dejafix / hooks / export / import
src/cli/tools.ts per-tool adapters: Claude Code, Codex, Cursor, Kiro, Antigravity, OpenCode, OpenClaw
src/bundle/      portable Brain Bundle export & import
benchmark/       reproducible recall benchmark
test/            301 tests: kernel, store parity, oplog, quantizer, MCP, proxy, tool-wiring,
                 Verified Recall, Déjà Fix, foreign-store audit, delete receipts, injection
                 controls, conflict audit, HTTP security (auth/host/content-type),
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
| `MEMWARDEN_SECRET` | unset | bearer token for the REST API and the proxy (clients send it as their API key) |
| `MEMWARDEN_INJECT` | on | `off` disables ALL auto-injection (SessionStart, Déjà Fix, proxy); `/recall` and MCP still work |
| `MEMWARDEN_CAPTURE` | on | `off` disables ALL auto-capture (PostToolUse hook, proxy tee) |
| `MEMWARDEN_UPSTREAM_URL` | unset | upstream OpenAI-compatible base URL; enables the proxy |
| `MEMWARDEN_UPSTREAM_KEY` | unset | API key forwarded to the upstream (omit for local models) |
| `MEMWARDEN_PROXY_PORT` | `3113` | port the memory proxy listens on |

## Not built yet (so this README does not pretend otherwise)

Verified Recall checks deletion and content drift; `doctor` additionally flags conservative
subject/value conflicts as advisories (it never drops them from recall).
Tamper-*evidence* ships via the hash chain, but oplog *signing* (Ed25519), *encrypted* Brain
Bundles, and an ANN index for >1M-memory scale are not. These are candidates, not claims. The
hash chain detects edits and reorders; it does not detect tail-truncation.

## License

Apache-2.0
