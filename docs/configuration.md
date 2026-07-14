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
| `MEMWARDEN_SECRET` | unset | bearer token for the REST API and the proxy (clients send it as their API key) |
| `MEMWARDEN_INJECT` | on | `off` disables ALL auto-injection (SessionStart, Déjà Fix, proxy); the recall prompt and MCP tools still work |
| `MEMWARDEN_RECALL_POLICY` | `balanced` | `verified-only` auto-injects ONLY hash-verified-current memory (strict ASI06 stance); `balanced` blocks detected-stale memory and keeps the rest (sourced and unsourced), each labeled |
| `MEMWARDEN_CAPTURE` | on | `off` disables ALL auto-capture (PostToolUse hook, proxy tee) |
| `MEMWARDEN_UPSTREAM_URL` | unset | upstream OpenAI-compatible base URL; enables the proxy |
| `MEMWARDEN_UPSTREAM_KEY` | unset | API key forwarded to the upstream (omit for local models) |
| `MEMWARDEN_PROXY_PORT` | `3141` | port the memory proxy listens on |

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
