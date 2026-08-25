# Configuration

All configuration is via environment variables (memwarden has no config file; the daemon reads
these at boot and the CLI bakes `MEMWARDEN_*` tuning into the service unit).

| Env | Default | Purpose |
| --- | --- | --- |
| `MEMWARDEN_DATA_DIR` | `~/.memwarden` | where the brain lives |
| `MEMWARDEN_EMBEDDING_PROVIDER` | `local` | `local` (on-device MiniLM) or `none` (keyword-only) |
| `MEMWARDEN_EMBED_DTYPE` | `fp16` | model weights: `fp16` (~300MB daemon RSS, recall == fp32), `q8` (~246MB, ~7pts R@10 cost), `fp32` (~386MB) |
| `MEMWARDEN_VECTOR_BACKEND` | `auto` | `auto` selects the native turbovec engine when its binary loads, else TypeScript; pin with `turbovec` or `typescript` |
| `MEMWARDEN_QUANT_VECTOR` | follows embeddings | force TurboQuant on/off |
| `MEMWARDEN_QUANT_BITS` | `4` | `2` or `4` bits per dimension |
| `MEMWARDEN_FORGET_TTL_DAYS` | `30` | retention window for the forget sweep: ordinary observations older than this that were never accessed are swept |
| `MEMWARDEN_FORGET_IMPORTANCE_FLOOR` | `5` | observations at or below this importance are sweepable once past the TTL; explicitly-important records (>5, e.g. user prompts) and anything ever accessed are always kept |
| `MEMWARDEN_FORGET_PROMOTE` | on | promote expiring code-backed observations into durable claim memories; `off` restores delete-only behavior |
| `MEMWARDEN_CONSOLIDATE_MIN_GROUP` | `3` | minimum number of evidence-equivalent copies required before proactive consolidation folds them |
| `MEMWARDEN_CONSOLIDATE_IMPORTANCE_FLOOR` | `5` | observations above this importance are protected from proactive consolidation |
| `MEMWARDEN_SECRET` | unset | bearer token for the REST API and the proxy (clients send it as their API key) |
| `MEMWARDEN_INJECT` | on | `off` disables ALL auto-injection (SessionStart, Déjà Fix, proxy); the recall prompt and MCP tools still work |
| `MEMWARDEN_RECALL_POLICY` | `balanced` | `verified-only` auto-injects ONLY hash-verified-current memory (strict ASI06 stance); `balanced` blocks detected-stale memory and keeps the rest (sourced and unsourced), each labeled |
| `MEMWARDEN_CAPTURE` | on | `off` disables ALL auto-capture (PostToolUse hook, proxy tee) |
| `MEMWARDEN_UPSTREAM_URL` | unset | upstream OpenAI-compatible base URL; enables the proxy |
| `MEMWARDEN_UPSTREAM_KEY` | unset | API key forwarded to the upstream (omit for local models) |
| `MEMWARDEN_PROXY_PORT` | `3141` | port the memory proxy listens on |

## Durability, consolidation, and retention

Code-backed knowledge is distilled, never dropped. Consolidation uses the primary file only as a
candidate bucket; it folds observations only when a deterministic identity establishes that their
claim payload and trust-relevant evidence are equivalent. Claim comparison normalizes Unicode,
whitespace, and fact/concept ordering, but does not ignore case, punctuation, code symbols, or
numbers. Evidence comparison includes the file set and hashes, cwd, command, agent, and
`mixedTrust`/confirmation state. Capture time may differ when all of that evidence is otherwise the
same. Each resulting Memory keeps the structured facts, concepts, source-observation ids, and one
verbatim provenance record for that evidence-equivalent claim.

Legacy per-file Memory ids used 16 hex characters while claim-specific ids use the full 64-character
digest, so the two formats cannot collide. An imported fingerprint-less row that explicitly uses a
claim id is migrated only when all reconstructible claim and evidence fields match. Otherwise the
imported row remains untouched and the new claim uses a deterministic fallback id; if that fallback
is also occupied, the source observations remain intact for inspection and retry.

Consequently, repeated copies of the same claim against the same file snapshot collapse to one
active Memory row and bound duplicate-row growth. Distinct claims about one file, changed file
hashes, and mixed-trust or hashless evidence remain separate and independently searchable. At the
TTL, each remaining code-backed observation is promoted under the same claim/evidence identity
before its raw row is removed; an installation or indexing failure leaves the source row for retry.
Oplog compaction may prune superseded payloads for repeated writes to one claim key because the
latest payload still contains that claim and its accumulated lineage. Separate claim keys remain
live and are not superseded by activity elsewhere in the file. Expiring observations with no file
provenance may still be removed, as may exact evidence-equivalent duplicates after their successor
is durable.

## Per-project and per-session switches

- `memwarden exclude <path>` firewalls a project completely - no capture from it, no injection
  into it, across hooks and proxy alike, effective immediately (the list is re-read per request).
  `memwarden include <path>` undoes it; `memwarden exclude --list` shows the list.
- `MEMWARDEN_INJECT=off` starts sessions with a clean slate; `MEMWARDEN_CAPTURE=off` stops
  auto-capture. Explicit recall and the MCP tools keep working under both.

## The proxy - one memory layer for the models you control

An OpenAI-compatible gateway on `:3141` that any model-configurable tool can point its base URL
at. It injects relevant firewall-passing memory, captures the answer, and is blind to the model
behind it. Local (Ollama, LM Studio) and paid (OpenAI, OpenRouter, Together) all speak the same
`/v1/chat/completions`, so it is one memory layer for all of them. Streaming (SSE) passes straight
through. It applies only where you control the model endpoint - tools with their own protocol or
backend (Claude Code, Cursor, Kiro, Antigravity) are covered by their native hooks instead.

```bash
# paid upstream:
MEMWARDEN_UPSTREAM_URL=https://api.openai.com/v1 MEMWARDEN_UPSTREAM_KEY=sk-... memwarden up
# local model, no key:
MEMWARDEN_UPSTREAM_URL=http://localhost:11434/v1 memwarden up
# then point your tool's OpenAI base URL at:  http://localhost:3141/v1
```

When the install has a secret (`memwarden up` generates one), the proxy requires it from clients
too: set your tool's API key to the secret (`cat ~/.memwarden/secret`). The proxy strips it before
forwarding, so it never reaches the upstream. Without this, any local process could spend your
upstream key and poison capture.
