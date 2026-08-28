# Changelog

All notable changes to memwarden. Dates are release dates; the format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Fixed
- **Firewall served counts now say what was actually returned.** Balanced recall no longer reports
  sourced or unsourced results as verified. `/memwarden/stats` and `status --json` expose a complete
  versioned breakdown for verified, cosmetic, sourced, unsourced, and legacy/unclassified values;
  human status shows the preserved total plus its nonzero classes. Counting occurs after token-budget
  packing and once per memory per event. Existing aggregate-only buckets remain readable but are never
  promoted to verified ([#78](https://github.com/saiyam1814/memwarden/issues/78)).

## 0.1.1 - 2026-08-28

Three defects found by running 0.1.0 on a real machine rather than in CI. The
first is a firewall bypass and is the reason this went out immediately.

### Security
- **`why --json` returned content the firewall had refused.** The human path
  correctly withheld a refused memory's title and narrative unless `--content`
  was passed; the JSON path returned before that policy was applied and printed
  the raw `/memwarden/why` response, which always carried both. Anyone holding a
  refused observation id — a script, or a model told only the id — could recover
  firewalled content through the explain path, which contradicts the whole point
  of refusing it. Withholding is now enforced **inside `mem::why`, before the
  response leaves core**, so the raw HTTP endpoint is fixed too and not just the
  CLI. Requesting content requires an explicit boolean (`include_content`, or
  `--content`), and it comes back in a dedicated field wrapped in
  untrusted-data markers rather than as bare `title`/`narrative` fields that a
  caller would slurp by accident ([#80](https://github.com/saiyam1814/memwarden/pull/80),
  closes [#77](https://github.com/saiyam1814/memwarden/issues/77)).

### Fixed
- **`status` called every served memory "verified".** Under the default
  `balanced` policy the firewall serves verified, cosmetic, sourced and
  unsourced memories, each labeled — but the recorder stored only a single
  `injected` total and status rendered that aggregate as `N verified served`.
  It now counts unique memories actually returned after policy filtering and
  token-budget packing, split by trust state. Counts recorded before this
  release cannot be re-derived, so they are reported as
  `legacy-unclassified` rather than retroactively claimed as verified
  ([#81](https://github.com/saiyam1814/memwarden/pull/81), closes
  [#78](https://github.com/saiyam1814/memwarden/issues/78)).
- **The managed daemon log was world-readable and unbounded.** The detached
  spawn path opened and chmod'd it to 0600, but the launchd installer only
  pointed `StandardOutPath`/`StandardErrorPath` at the file, so launchd created
  it with the default 0644 — measured at 3.7 MB on a real install. Logging is
  now descriptor-safe across both paths with regular-file, ownership,
  hard-link, symlink and containment checks, enforced 0600, and bounded to one
  1 MiB current file plus one 1 MiB tail generation while preserving launchd's
  open inode. systemd continues to use journald
  ([#82](https://github.com/saiyam1814/memwarden/pull/82), closes
  [#79](https://github.com/saiyam1814/memwarden/issues/79)).

## 0.1.0 - 2026-08-26

The first public beta. Everything below was found by running the tool against a
real install rather than a fixture, which is why the version moved from 0.0.x.

### Fixed
- **Canon push/pull actually round-trips.** Export/import is authenticated and
  project-scoped, preserving hashes, identity, title/content and attestation
  with safe merge semantics ([#65](https://github.com/saiyam1814/memwarden/pull/65)).
- **Explicit saves survive retention.** A first-class durable `mem::remember`
  path with honest authorship, optional file evidence, supersession, deletion
  receipts, and path normalization hardened against traversal, null bytes and
  symlink escapes ([#66](https://github.com/saiyam1814/memwarden/pull/66)).
- **MCP search is firewalled and labeled.** Trust classification now runs
  independently of the inclusion policy, search defaults to project-scoped
  current recall, and drift/superseded history is exposed with temporal framing
  ([#67](https://github.com/saiyam1814/memwarden/pull/67)).
- **Consolidation preserves distinct same-file claims** instead of folding two
  different decisions about one file into a single memory
  ([#68](https://github.com/saiyam1814/memwarden/pull/68)).
- **Project identity is separate from checkout path**, so worktrees of one repo
  stop confusing scoping across search, doctor, why, consolidation, Canon,
  bundles and fleet ([#69](https://github.com/saiyam1814/memwarden/pull/69)).
- **The half-life study's median was wrong.** The quantile helper took the
  upper-middle value for even samples instead of averaging the two middle ones,
  which biased every median high. The 180-day figure is **61.8%**, not the
  previously published 78.1%. Worse, the bug masked the sensitivity analysis:
  fastapi's 180-day rate is 11.8% with localized docs excluded and 71.5% with
  them included, but both orderings put 78.1% at the same index, so the two runs
  looked identical and were reported as evidence of robustness. They were not.
  Fixed with tested R-7 quantiles, a pinned four-repository manifest, both
  control arms, microdata and hashes ([#70](https://github.com/saiyam1814/memwarden/pull/70)).

### Added
- **The release is gated on the packed npm artifact**, not the repo. The exact
  `npm pack` output is installed under an isolated HOME and driven through real
  CLI, daemon, MCP, authenticated HTTP, persistence, Canon, erasure and clean
  shutdown, on Linux, macOS and Windows. This is the check that would have
  caught the 0.0.5 defect where `consolidate.js` was simply absent from the
  published tarball ([#71](https://github.com/saiyam1814/memwarden/pull/71)).
- **A `cosmetic` trust state.** A file that was reformatted but whose normalized
  content is unchanged is labeled `source-cosmetic` — current, but explicitly
  not byte-identical — and is admitted under `verified-only`. Two eval gates
  bound it: `cosmetic-admitted` (reformatted memory flows under strict policy)
  and `cosmetic-bounded` (genuinely drifted memory is still refused). The pair
  matters; alone, the first would let "cosmetic is allowed" drift into "any
  change is allowed" without the eval noticing.

### Note for existing installs
Memories captured before 0.0.8 keep their old shape and age out through normal
retention. `npm run inspect` grades your store; `memwarden doctor . --fix-stale`
clears stale records now.

## 0.0.9 - 2026-08-24

Caught by inspecting the store the day 0.0.8 shipped, which is the point.

### Added
- **`npm run inspect`** (`eval/inspect-store.ts`): grades the live brain against
  the same quality rules the capture path enforces — titles that are bare tool
  names, bodies that carry JSON, records with no facts and no concepts, and
  whether importance has any spread at all — then prints the most recent captures
  to *read*, because no aggregate can tell you whether the knowledge is worth
  having. Reads a snapshot, never the live file, and mutates nothing.

  It exists because 761 passing tests and a 100% firewall eval both reported
  "healthy" while the store was full of tool logs. Reading the rows is the only
  check that caught it, so it is now one command.

### Fixed
- **JSON output envelopes no longer end up in memory bodies.** 0.0.8 fixed titles
  and facts but still appended raw tool *output* verbatim, which produced bodies
  like `Wrote inspect-store.ts. {"type":"create","filePath":"…","content":"//…"` —
  an entire written file stored inside its own memory. Output is now mined for the
  one field a human would read (`stdout`, `output`, `stderr`, `message`, …) and
  everything else is dropped. `content`/file-body fields are deliberately never
  harvested: they are the payload we are trying not to keep.
- **The inspector's own JSON check** looked only at the start of a body, so
  `Wrote foo.ts. {"content":…}` passed as clean. It now matches JSON anywhere.
- **Bare-tool-name detection is case-insensitive.** Hosts differ on casing
  (`Read` vs `read`), and the case-sensitive check silently under-counted.

## 0.0.8 - 2026-08-24

One fix, and it is the one that decides whether any of the rest matters.

### Fixed
- **Memories describe the change, not the tool** ([#3](https://github.com/saiyam1814/memwarden/issues/3)).
  Inspecting a real six-week install found 379 stored memories shaped like
  `title: "Write"` with the raw tool-input JSON as the body and `facts`/`concepts`
  always empty. Every title was one of six tool names, so nothing was rankable;
  every body was a JSON blob, so nothing was readable; and hybrid search had
  almost no real terms to match on. Provenance and hashing worked perfectly and
  were verifying junk.

  Extraction is now rule-based (still zero-LLM, still no token spend): titles
  describe the change (`auth.ts: ROTATE_MS = 900_000 → ROTATE_MS = 3_600_000`,
  `npm test -- --coverage`, `Searched "authentication"`), bodies are prose with
  raw tool input never stored as content, `facts` carry the actual change, the
  command run and error lines, and `concepts` are mined from path segments and
  code-shaped symbols. A bare read with nothing extractable now sinks below the
  retention floor so the sweep ages it out instead of distilling it into a
  permanent row.

  Five further defects were found by inspecting live captures rather than
  fixtures, each now pinned by a test: loose error matching that fired on any
  file merely mentioning an error and on `{"success":true}` envelopes (marking
  *every* capture importance 6 and destroying ranking); raw JSON leaking back
  into facts; the OS username leaking into concepts from `/Users/<name>/…` on
  every memory; escape sequences fusing into identifiers (`\tisPremium` →
  `tisPremium`); and shouty English (`THE`, `GATE`, `PASS`) matching
  CONSTANT_CASE and burying real identifiers.

  A regression gate now fails the suite if any title is a bare tool name or any
  body parses as JSON carrying a `file_path`. Three pre-existing tests had been
  asserting the old broken behavior (`expect(title).toBe("Grep")`) — the suite
  was green because it was protecting the defect.

### Note for existing installs
Memories captured before this release keep their old shape. They age out through
normal retention, or `memwarden doctor . --fix-stale` clears the stale ones now.
New captures are correct immediately after upgrading.

## 0.0.7 - 2026-08-24

Follow-ups to the 0.0.6 beta, all found by running the tool against a real
install rather than a fixture.

### Added
- **`status` shows what the firewall actually did.** Every firewall-gated recall
  records its outcome in daily buckets, surfaced in `/memwarden/stats` and
  `status`: `firewall  🛡 8 stale refused · 50 memories served  (last 30d, 2 recalls)`.
  The original 0.0.7 renderer incorrectly called that balanced-policy aggregate
  "verified"; current versions split new counts by trust and preserve old totals
  as legacy/unclassified ([#78](https://github.com/saiyam1814/memwarden/issues/78)).
  memwarden had been blocking stale memory for six weeks on a real install
  without ever saying so, and silent protection reads as no protection. Counting
  is deliberately conservative: recall **events** not candidates, memories
  actually withheld (once per memory per event), no Déjà Fix credit for an empty
  lookup, and `hasData: false` on a fresh install instead of a confident row of
  zeros. UTC-keyed buckets, pruned past 45 days on write, so the history stays
  bounded.

### Fixed
- **The embedding runtime shipped binaries that can never load.** `npm install
  @huggingface/transformers` pulls onnxruntime for every target: on a darwin/arm64
  install, 425MB of runtime held 86MB of `onnxruntime-web` (a browser build Node
  never loads) and ~145MB of native libraries for linux-x64, linux-arm64,
  win32-x64, win32-arm64 and darwin-x64. `memwarden up` now prunes to the current
  platform/arch. Verified live: **425MB → 157MB, 267MB freed**, semantic search
  still working. With `compact --prune-history` this took a real brain from 848MB
  to 331MB. `MEMWARDEN_RUNTIME_PRUNE=off` keeps everything.
- **The `status` storage line is itemized** (`180MB memory + oplog · 152MB
  embedding runtime`) and only advises the lever that would help the dominant
  cost — `compact` cannot shrink the model runtime, and suggesting it for that is
  worse than saying nothing. Also: the database is a file, so it is measured with
  `stat` (plus its `-wal`/`-shm` siblings) rather than a directory walk that
  returned 0.
- **The release workflow could not use trusted publishing.** `NODE_AUTH_TOKEN` was
  exported unconditionally, so a present-but-stale `NPM_TOKEN` shadowed the OIDC
  path the workflow had already been granted `id-token` permission for — which is
  why 0.0.6 failed to publish with a bare `E404`. The token is now exported only
  when non-empty, the chosen auth path is stated before the attempt, and an E404
  prints the actual remedy.

### Known
- `@memwarden/turbovec` throws `mutex lock failed` during daemon shutdown
  ([#43](https://github.com/saiyam1814/memwarden/issues/43)). Pre-existing, on the
  teardown path only; `MEMWARDEN_VECTOR_BACKEND=typescript` avoids the native path.

## 0.0.6 - 2026-08-24

The first public beta. Two of these are corrections to bugs that made the layer
dishonest in practice, and they are listed first on purpose.

### Fixed
- **The durability contract: code-backed knowledge is distilled, never dropped.** The
  retention sweep deleted expiring observations without checking whether anything durable
  had been distilled from them first. Measured on a real 0.0.5 install: 15,771 observations
  captured, **0 memories**, and hundreds of code-backed rows removed per hour at the TTL —
  the layer was a sieve. At the TTL an observation carrying file provenance is now promoted
  into a Memory (via `distillMembers`, the same primitive the consolidate pipeline uses),
  carrying its content and capture-time hashes verbatim so Verified Recall still re-checks
  it against the live file. Repeat support for the same claim and evidence converges on one
  memory id; distinct same-file claims, snapshots, and trust boundaries remain separate.
  Observations with no provenance have nothing durable to promote and are deleted as before.
  This also makes sweep-vs-consolidate ordering irrelevant.
  `MEMWARDEN_FORGET_PROMOTE=off` restores the old behavior.
- **Consolidation reaches published builds.** The distillation pipeline (0.0.5 development)
  was absent from the published 0.0.5 tarball, which is why installs reported 0 memories.
- **`status` diagnoses itself.** It printed `0 memories` beside `15771 observations` for
  weeks without flagging it. It now names the condition ("distillation is not running") and
  what to run, and prints the on-disk footprint with a reclaim hint when the brain is large.

### Added
- **Verified Memory Canon — git-native portable verified memory.** `memwarden canon push`
  promotes distilled memories into `.memwarden/canon.jsonl` in your repo (one JSON record
  per line, repo-relative paths, capture-time SHA-256 per file). `canon verify` re-hashes
  the canon against *any* checkout and reports verified/stale/unverifiable with the files
  that drifted; `--strict` exits 1 as a CI gate. `canon pull` loads what still holds into
  the local brain through the normal capture path, so the firewall still governs it.
  Trust becomes portable with no server, no account, and no vendor. `push` refuses to
  promote memory that is already stale locally, and memory with no capture-time hashes;
  serialization is byte-stable so an unchanged brain re-pushes identically; paths outside
  the repo are refused rather than leaked; malformed lines (merge conflicts) are skipped,
  not fatal. Stated in the output: a matching hash proves the source is unchanged, not that
  the claim is correct.
- **Fleet mode, phase 2**: an agent registry (one row per active agent, keyed by session,
  evicted on session end plus a 24h lazy prune and a clock clamp) and
  `memwarden fleet status [--cwd dir] [--json]` with `POST /memwarden/fleet/status` — which
  agents are working in this project right now, what each is touching, capture counts and
  last-seen. Thanks @sivasubramanian95 (#34, #25) and #35 (#26).
- **`memwarden compact --prune-history [--keep-days N]`**: reclaims the dominant share of
  on-disk size by dropping *superseded* oplog payload copies while keeping every entry's
  `payload_hash`, so the chain still verifies end to end. Measured on a real install the
  oplog held 319MB of payloads against 16.6MB of live state — 95% of the database was
  historical copies nobody could read.

### Changed
- `up`/`down` are scoped to the daemon they target: pointing `MEMWARDEN_URL` /
  `MEMWARDEN_REST_PORT` at a throwaway daemon no longer rewrites every real tool's config
  or unloads the user-global service, and `--wire` is the explicit opt-in. URL comparison is
  normalized (case, trailing slash, `127.0.0.1`/`[::1]` folded into `localhost`), and
  non-default `down --data` refuses to delete the default brain. Thanks @d-cryptic (#21, #17).

## 0.0.5 - 2026-07-13

The launch release: session journals, verifiable erasure, the native engine, and the
firewall made measurable.

### Added
- **Session journals**: `hook prompt` / `hook session-end` across all six hosts capture the
  prompt that started the work and a deterministic handoff summary (goal, what happened,
  decisions, open threads) - not just clipped tool output. Handoffs are searchable and carried
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
  erasure) and `npm run eval` - 250 memories across verified/sourced/unsourced classes,
  5 projects, 50 staleness events, 5 poisoned-handoff traps, 3 delimiter forgeries; CI-gated
  at 100% on all eight gates (stale-retrievable, stale-refusal, fresh-retention, isolation,
  label accuracy, handoff-trust, verified-only policy, injection containment).
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
- Handoff summaries now inherit provenance from their source observations - stale facts can no
  longer launder through summaries past the firewall.
- **Mixed-trust handoffs can never classify `verified`**: a handoff digest embeds unsourced
  content (the prompt, the outcome) beside inherited file hashes, so matching hashes now earn
  it `sourced` at most - a hostile prompt cannot ride one unchanged file past the
  `verified-only` policy. Drift still proves it stale.
- **Refusal evidence no longer re-injects refused content**: the firewall notice carries the
  observation id and the verdict's reason, never the refused memory's title (a stale handoff's
  title embeds the user's prompt). `memwarden why <id>` is the inspection path.
- **Erasure is source-preserving, idempotent, and convergent** (deliberately NOT atomic -   there is no cross-record transaction): the cascade runs before the source delete and
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
  compacts, and byte-scans the store files - and exits non-zero if the canary survives.
- The eval gained gates for retrievability preconditions, sourced/unsourced label accuracy,
  poisoned-handoff traps, the verified-only policy, and injection containment (forged
  delimiters through real storage + recall + the shared formatter) - 8 gates, all at 100%.
- **Capped capture evidence never certifies `verified`**: when a tool call references more
  files than the capture bound (now 64, was a silent 20) or nests deeper than the walk,
  the provenance is marked incomplete - drift in an uncaptured file can no longer hide
  behind matching hashes over the captured subset.
- **Handoff claims carry their own evidence (claim lineage)**: decisions and unresolved
  errors inherit provenance from the observations whose text they copy, all-or-nothing; a
  claim whose evidence cannot be tracked is dropped from the handoff text entirely, so no
  cap boundary can leave an untracked claim injectable.
- **Erase receipts verify residuals**: after the cascade, the session's remaining records
  are scanned for the erased content; an echo surviving in a sibling observation or a
  preserved Outcome flips `contentErased` to false and names the residual. Outcomes that
  echo the erased content are dropped from rebuilds instead of re-injected. Detection covers
  shared phrases (5-word shingles), compact whole values (>= 6 chars), and short secrets -   digit-bearing tokens like `PIN 7391` and long identifiers - with year-shaped numbers
  excluded to avoid date false-positives.
- The cascade computes every re-derived value before writing (idempotent two-phase apply),
  and a partial failure reports honestly: source not deleted, derived records possibly
  partially re-derived, retry converges.
- **One shared injection formatter for every surface**: SessionStart, the proxy, Déjà Fix
  (whose root cause used to sit outside the markers), and the MCP `/recall` prompt (which had
  no framing at all) now build their blocks in `injection-format.ts` - framing plus delimiter
  defanging, with a formatter-level invariant test and an eval gate.
- Residual detection covers short body values (`admin`) via word-boundary tokens, and receipts
  carry a hashed tri-state `residualScan` (`clean` / `residuals` / `limited`): a value below
  the detection floor marks the scan `limited` and the headline `contentErased` is refused
  rather than overstated.
- Refusal-notice hardening: verdict reasons (which embed repo-controlled file names) are
  stripped of control characters, `<`/`>`/`&`-escaped (a filename can no longer forge a
  closing delimiter and break out of the block), and rendered inside an explicit
  untrusted-data block; recalled-memory injection defangs its own delimiter the same way;
  `memwarden why` withholds refused content by default (`--content` prints it as framed,
  sanitized data), and sanitizes verdict reasons, file names, and titles in its metadata
  lines (repo-controlled names cannot fabricate output lines).
- Release hardening: the retired `macos-13` runner replaced with `macos-15-intel`; Linux
  native binaries must pass a clean-container (no OpenBLAS) load test before publish; the
  npm release gate now runs the firewall eval and the end-to-end demo.
- MCP server reported a hardcoded version; it now reports the real package version.

## 0.0.4 - 2026-07-11 (not published to npm; changes ship in 0.0.5)

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

## 0.0.3 - 2026-07-11

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

## 0.0.2 - 2026-06-12

Ten bugs from an adversarial review, each reproduced before fixing. Highlights: daemon no
longer crashes on first boot against a missing data dir; `up`/`connect` refuse to bake
transient npx-cache paths into configs; foreign-store audit parses timezone-less SQLite
timestamps as UTC; `safe_only` recall fails closed without a cwd; proxy tee survives client
disconnects with bounded buffering; MCP auth failures surface instead of reading as empty
success. Added `memwarden audit --html` shareable reports.

## 0.0.1 - 2026-06-11

First published alpha: Verified Recall (source-file hashes as ground truth, `safe_only`
firewall), `memwarden doctor`, foreign-store `audit`, hash-chained oplog with delete receipts,
TurboQuant compressed vectors, dependency-free MCP server, OpenAI-compatible proxy,
`memwarden up` wiring seven tools with a self-healing daemon, Déjà Fix, and per-project
injection/capture controls.
