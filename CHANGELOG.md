# Changelog

All notable changes to memwarden. Dates are release dates; the format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## 0.0.5 — unreleased

The launch release: session journals, verifiable erasure, the native engine, and the
firewall made measurable.

### Added
- **Session journals**: `hook prompt` / `hook session-end` across all six hosts capture the
  prompt that started the work and a deterministic handoff summary (goal, what happened,
  decisions, open threads) — not just clipped tool output. Handoffs are searchable and carried
  across tools.
- **Verifiable erasure**: `forget --erase` nulls a memory's oplog payloads in place (chain v2
  commits to payload *hashes*, so the chain still verifies); `memwarden compact [--dry-run]`
  re-chains from genesis, reclaims bytes with VACUUM, and anchors the previous head hash in the
  compact record. Receipts carry a real `contentErased` boolean and the chain head.
- **Native vector engine**: `@memwarden/turbovec` (napi-rs binding, prebuilt per platform).
  Auto-selected when the binary loads, honest TypeScript fallback when it doesn't;
  `memwarden status` always names the backend actually serving. ~125× faster search at 10K
  vectors with zero recall drop; scope filters run inside the kernel as allowlists.
- **Canonical hook layer**: `hook <sub> --host claude-code|codex|cursor|gemini|kiro|opencode`
  with per-host writers/removers; AGENTS.md demoted to explicit fallback.
- **Scoped vector search**: project/cwd filters run as allowlists inside the vector search
  instead of post-filtering a global top-k (filtered 10K/20-project benchmark: half-empty
  top-10s become full, 15–22 ms becomes ≤1.5 ms TypeScript / 0.2 ms native).
- **Firewall demo and eval**: `npm run demo:firewall` (real daemon, ends in a byte-scan-proven
  erasure) and `npm run eval` — 250 memories across verified/sourced/unsourced classes,
  5 projects, 50 staleness events, 5 poisoned-handoff traps; CI-gated at 100% on all seven
  gates (stale-retrievable, stale-refusal, fresh-retention, isolation, label accuracy,
  handoff-trust, verified-only policy).
- `memwarden why <id>` explains one memory's trust verdict; `doctor --fix-stale [--erase]`
  clears the stale inbox; `up` ends with live status and concrete next steps; SessionStart
  surfaces firewall refusal evidence instead of a silent empty inject.
- Session project-mismatch guard: an existing session refuses observations from a different
  project (defense-in-depth over the per-project MCP/proxy session ids).
- Git-remote project identity: recall follows the repo across clones and worktrees.
- `memwarden --version` / `--help`; `import` validates the file is a real Brain Bundle before
  sending it to the daemon.
- Release automation: npm publish with provenance on `v*` tags; per-platform native prebuilds
  on `turbovec-v*` tags.

### Fixed
- Handoff summaries now inherit provenance from their source observations — stale facts can no
  longer launder through summaries past the firewall.
- **Mixed-trust handoffs can never classify `verified`**: a handoff digest embeds unsourced
  content (the prompt, the outcome) beside inherited file hashes, so matching hashes now earn
  it `sourced` at most — a hostile prompt cannot ride one unchanged file past the
  `verified-only` policy. Drift still proves it stale.
- **Refusal evidence no longer re-injects refused content**: the firewall notice carries the
  observation id and the verdict's reason, never the refused memory's title (a stale handoff's
  title embeds the user's prompt). `memwarden why <id>` is the inspection path.
- **Erasure is source-preserving, idempotent, and convergent** (deliberately NOT atomic —
  there is no cross-record transaction): the cascade runs before the source delete and
  computes every re-derived value before writing, so a failure never deletes the source,
  may leave derived records partially re-derived (the failure message says so), and a retry
  converges to the fully erased state. Receipts gain a hashed `eraseIncomplete` field;
  `contentErased` is true only when the source payloads, every derived copy, AND the residual
  scan come back clean.
- Cascade rebuilds preserve the handoff's Outcome line instead of silently dropping it.
- Observe refusals (session-project mismatch) return HTTP 409 instead of 201, the dedup key is
  project-scoped so a cross-project duplicate can't bypass the guard, and hook events without
  a session id fall back to a per-project session instead of a global shared one.
- The firewall demo now proves its erasure claim: it erases every canary-bearing observation,
  compacts, and byte-scans the store files — and exits non-zero if the canary survives.
- The eval gained gates for retrievability preconditions, sourced/unsourced label accuracy,
  poisoned-handoff traps, and the verified-only policy (250 memories, 7 gates, all at 100%).
- **Capped capture evidence never certifies `verified`**: when a tool call references more
  files than the capture bound (now 64, was a silent 20) or nests deeper than the walk,
  the provenance is marked incomplete — drift in an uncaptured file can no longer hide
  behind matching hashes over the captured subset.
- **Handoff claims carry their own evidence (claim lineage)**: decisions and unresolved
  errors inherit provenance from the observations whose text they copy, all-or-nothing; a
  claim whose evidence cannot be tracked is dropped from the handoff text entirely, so no
  cap boundary can leave an untracked claim injectable.
- **Erase receipts verify residuals**: after the cascade, the session's remaining records
  are scanned for the erased content; an echo surviving in a sibling observation or a
  preserved Outcome flips `contentErased` to false and names the residual. Outcomes that
  echo the erased content are dropped from rebuilds instead of re-injected. Detection covers
  shared phrases (5-word shingles), compact whole values (>= 6 chars), and short secrets —
  digit-bearing tokens like `PIN 7391` and long identifiers — with year-shaped numbers
  excluded to avoid date false-positives.
- The cascade computes every re-derived value before writing (idempotent two-phase apply),
  and a partial failure reports honestly: source not deleted, derived records possibly
  partially re-derived, retry converges.
- Refusal-notice hardening: verdict reasons (which embed repo-controlled file names) are
  stripped of control characters, `<`/`>`/`&`-escaped (a filename can no longer forge a
  closing delimiter and break out of the block), and rendered inside an explicit
  untrusted-data block; recalled-memory injection defangs its own delimiter the same way;
  `memwarden why` withholds refused content by default (`--content` prints it as framed,
  sanitized data).
- Release hardening: the retired `macos-13` runner replaced with `macos-15-intel`; Linux
  native binaries must pass a clean-container (no OpenBLAS) load test before publish; the
  npm release gate now runs the firewall eval and the end-to-end demo.
- MCP server reported a hardcoded version; it now reports the real package version.

## 0.0.4 — 2026-07-11 (not published to npm; changes ship in 0.0.5)

### Fixed
- **MCP scoping (P0)**: `memory_remember` stored everything under the literal project `"mcp"`;
  now scoped to the server's cwd. `memory_search` is project-scoped with an `all_projects`
  escape hatch.
- **Wrong-checkout verification (P0)**: same-project recall now verifies file hashes against
  the *caller's* checkout, not the capture-time path.
- **Honest deletion (P0)**: receipts state `contentErased: false` outright; the CLI and README
  say the oplog residual remains (erasure landed in 0.0.5).
- Cold-rebuild ordering hid old memories after an early observe; `~/.memwarden` is 0700, the
  db and secret-bearing configs 0600; retention floor corrected (1–10 importance scale).

### Added
- `MEMWARDEN_RECALL_POLICY=verified-only` (strict stance: auto-inject only hash-verified
  memory) and untrusted-data framing around every injection.
- CI (ubuntu/macos × node 20/22 + fresh-tarball smoke), SECURITY.md.

## 0.0.3 — 2026-07-11

The truth release.

### Added
- `memwarden status [--json]` (daemon, semantic engine, vector backend, per-tool wired/live),
  `down --all [--data]` full reversal, local embeddings runtime installed by `up` into
  `~/.memwarden/runtime`.

### Changed
- Hooks carry hard deadlines (2000/1500/800 ms) so a slow daemon can never stall the host tool.
- Benchmark rescored honestly (no exact rescore, 2,000 distractors) and the README numbers
  updated to match.
- Proxy port moved 3113 → 3141 (3113 collided with another memory tool's viewer).

### Known issue
- `memory_remember` project scoping bug, fixed in 0.0.4. If you are on 0.0.3, upgrade.

## 0.0.2 — 2026-06-12

Ten bugs from an adversarial review, each reproduced before fixing. Highlights: daemon no
longer crashes on first boot against a missing data dir; `up`/`connect` refuse to bake
transient npx-cache paths into configs; foreign-store audit parses timezone-less SQLite
timestamps as UTC; `safe_only` recall fails closed without a cwd; proxy tee survives client
disconnects with bounded buffering; MCP auth failures surface instead of reading as empty
success. Added `memwarden audit --html` shareable reports.

## 0.0.1 — 2026-06-11

First published alpha: Verified Recall (source-file hashes as ground truth, `safe_only`
firewall), `memwarden doctor`, foreign-store `audit`, hash-chained oplog with delete receipts,
TurboQuant compressed vectors, dependency-free MCP server, OpenAI-compatible proxy,
`memwarden up` wiring seven tools with a self-healing daemon, Déjà Fix, and per-project
injection/capture controls.
