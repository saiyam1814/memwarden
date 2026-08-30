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
- **Fine-grained anchors are a bounded first slice.** Memwarden can revalidate a unique successful
  edit replacement, an explicit bounded read range, or an explicit unambiguous top-level JSON
  key/value without invalidating it for unrelated changes elsewhere in the file. The capture binds
  the exact stored synthetic claim to an operation-supported claim hash and commits bounded adjacent
  structural context; relocation requires that context to match. Partial, mixed/capped, duplicate,
  malformed, oversized, claim-mismatched, or context-ambiguous anchors remain advisory and whole-file
  drift still blocks current recall. Anchor records contain hashes and locations, not retained source
  or claim payloads.
- **No heuristic symbol or rename recovery exists yet.** AST/function/class/export anchors, parser
  versioning, deterministic git rename relocation, nested JSON paths, YAML/TOML/INI/manifest
  adapters, and structural hashes are future work. Memwarden does not guess them with regexes.
  Command and test output remains historical evidence; this release does not rerun a verifier and
  therefore never upgrades it to live source verification.
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
