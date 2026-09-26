# Honest limits (what memwarden does NOT do)

This file exists so the README does not have to pretend otherwise.

## Trust model

- **`balanced` (the default) means "not detected stale," not "proven safe."** Sourced and
  unsourced memory still flow, each labeled. Stale memory is blocked. If your threat model includes
  hostile repos or tool output, run `MEMWARDEN_RECALL_POLICY=verified-only`, which auto-injects
  only hash-verified-current memory.
- **Verified Recall checks deletion and content drift**, not semantic correctness. `doctor`
  additionally flags conservative subject/value conflicts as advisories - it never drops them from
  recall.
- **Shell-read evidence is a conservative parse, not a sandbox trace.** memwarden reads the command
  line, not the process, and only for local shell tools (never an MCP tool that runs a command on
  another machine). It recognizes a fixed set of read-only viewers: `cat`, `sed -n` with an
  address-and-print script, `head`, `tail`, `grep`/`rg`/`ag` with file operands, `jq`, `diff`, `wc`,
  checksum tools, and `sort`/`cut`/`awk` with file operands. Files named by options (`grep -f`,
  `jq --rawfile`) count too. A file is kept only if it hashes at capture, and any candidate that does
  not hash caps the memory at `sourced`. The following yield no shell evidence at all: command or
  process substitution, heredocs, unterminated quotes, and any `cd` that is not absolute and
  followed by `&&`. The following keep the files that were found (so drift is still caught) but cap
  the memory at `sourced`: globs, brace expansion, variables, `..` segments, temp files, directories,
  other commands in the chain, stdout redirects to a file, and programs that can read or run more
  than their operands (sed `r`/`w`/`e`, awk `getline`/`system`, jq `env`/`import`). Two things are
  invisible to this parse: anything a command reads that is not on its command line (a script's
  own inputs, `make`, test runners), and shell aliases or functions that shadow a viewer's name.
- **Injection framing is a mitigation, not a proof.** Recalled content is delimited and framed as
  untrusted data (`<memwarden-memory>` markers, embedded delimiters defanged), which reduces but
  does not eliminate prompt-injection risk from hostile stored text.

## Tamper-evidence

- **Tamper-evident, not tamper-proof.** The hash chain detects edits and reorders; it does **not**
  detect tail-truncation (dropping the newest entries). There is no signing.
- **Erasure cannot reach copies outside the store** - filesystem snapshots, backups, earlier
  `memwarden export` files, or bytes an SSD's wear-leveling retired.
- **Residual detection is best-effort.** It catches shared phrases, compact values, and short
  secrets; a value below its detection floor marks the scan `limited` and the receipt refuses the
  clean claim rather than overstate it.

## Not built yet

Oplog *signing* (Ed25519), *encrypted* Brain Bundles, an ANN index for >1M-memory scale, desktop
apps, cloud sync, and team memory are candidates, not claims.

## Platform

**Windows**: the daemon runs, but service supervision (auto-restart on crash, start at login) is
macOS (launchd) and Linux (systemd) only. On Windows the daemon lives for the login session and
self-heals on next use; rerun `memwarden up` after a reboot. A Windows service installer is on the
roadmap, not shipped.

**Native turbovec backend**: prebuilt for macOS (arm64/x64) and Linux x64. Linux arm64 and Windows
use the pure-TypeScript vector backend - same results, just not the ~125× speedup. `memwarden
status` always names the backend actually serving, and the default (`auto`) loads native only where
its binary is present. So memwarden is correct and fully functional everywhere; native is an
accelerator, never a requirement.
