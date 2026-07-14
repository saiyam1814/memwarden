# Security policy

memwarden's whole thesis is trust, so security reports get priority attention.

## Reporting

Email saiyam911@gmail.com, or use GitHub's private vulnerability reporting on this
repository. Please do not open public issues for exploitable problems. You can
expect an acknowledgment within 72 hours.

## Scope and threat model (honest edition)

What memwarden defends today:

- **Daemon access**: loopback-only, Host-header firewall (DNS-rebinding),
  bearer-secret auth with timing-safe compare, application/json enforcement.
- **Memory poisoning (OWASP ASI06)**: known-stale memory is blocked before
  injection; auto-injected recall is delimited and framed as non-instruction
  data; `MEMWARDEN_RECALL_POLICY=verified-only` restricts auto-injection to
  hash-verified-current memory.
- **Local privacy**: `~/.memwarden` is 0700, the database and every config
  carrying the secret are 0600.
- **Tamper evidence**: SHA-256 hash-chained oplog. Tamper-evident, NOT
  tamper-proof: no signing, and tail-truncation is not detectable.

- **Verifiable erasure**: oplog entries commit to the SHA-256 of their
  content (chain v2), so `memwarden forget --erase` and `memwarden compact`
  null deleted memories' content in place while the chain keeps verifying.
  SQLite `secure_delete` is on and the WAL is checkpointed, so the bytes
  leave the database file, not just the rows (compact also VACUUMs).

Known limitations, stated on purpose:

- Plain `memwarden forget` (without `--erase`) removes content from the
  active store and every index, but the original content remains in the
  local append-only oplog (receipts say `contentErased: false`) until you
  erase or compact.
- Erasure cannot reach copies outside the store: filesystem snapshots and
  backups, earlier `memwarden export` files, or physical remnants a drive's
  wear-leveling/journaling kept. Chain history from before an erasure that
  someone copied elsewhere still contains the content.
- Pre-v2 oplog entries hash over the raw content, so in-place erasure
  refuses them; `memwarden compact` migrates the whole chain to v2 (the old
  head hash is anchored in the compaction record, and receipts carry the
  `chainHead` they were issued against).
- The database is not encrypted at rest; disk encryption is the OS's job for
  now.
- The default `balanced` recall policy means "not detected stale", not
  "proven safe" - unsourced memory is injectable, labeled.

Reports about any gap between what the README claims and what the code does
are treated as security reports.
