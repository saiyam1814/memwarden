//
// Verified Memory Canon — the portable half of Verified Recall.
//
// Until now the hash chain only proved anything on the machine that made it.
// A memory verified against MY checkout said nothing to YOUR agent, so every
// teammate (and every fresh clone, and CI) started from an empty brain and
// spent weeks re-learning what the team already knew.
//
// The canon fixes that by moving distilled memories OUT of the private brain
// and INTO the repo as a committed, reviewable artifact:
//
//   .memwarden/canon.jsonl   one JSON record per line, newline-delimited so
//                            git diffs it per-memory and merges it like code
//
// Each record carries repo-relative file paths and the capture-time SHA-256 of
// each file. That is the whole trick: any checkout can re-hash those files and
// decide for itself whether the memory still holds. Trust becomes portable
// without a server, an account, or a vendor — `canon verify` is the same
// firewall verdict, computed locally, by whoever cloned the repo.
//
// It also draws the line the 0.0.5 sieve bug proved we needed: raw captures are
// private, ephemeral scratch under ~/.memwarden; distilled memories are the
// durable layer; and PROMOTION into the repo is a reviewable event. A bad
// memory gets caught in code review, like a bad migration.
//
// Honesty boundary, stated in the output and the docs: a matching hash proves
// the memory's source is UNCHANGED, not that the memory's claim is CORRECT. A
// wrong decision recorded against a file that never changed stays wrong. The
// canon narrows staleness, which is the failure mode that silently misleads
// agents; it is not a correctness oracle.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { hashFiles } from "../functions/verify.js";

// --- secret gate ----------------------------------------------------
//
// `canon push` writes into a file that gets COMMITTED, and git history is a
// one-way door: a leaked credential is an incident and a history rewrite, not a
// delete. Memory content is compressed tool output, and tool output includes
// `cat .env`, terraform plans, stack traces with connection strings. So the
// canon has a hard gate on the way in.
//
// Targeted detectors, not entropy heuristics: entropy alone floods on hashes,
// UUIDs and minified code, and users who learn to bypass a noisy gate bypass it
// when it matters. There is deliberately NO override flag — `--all` relaxes the
// STALENESS gate only. A memory carrying a credential is a memory to forget,
// not to force through.
const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "private key block", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "OpenAI-style API key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { label: "OpenRouter key", re: /\bsk-or-v1-[A-Za-z0-9]{32,}\b/ },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    label: "credentialed connection string",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i,
  },
  {
    label: "assigned credential",
    re: /\b(?:api[_-]?key|secret|password|passwd|token|bearer)\b["'\s]*[:=]["'\s]*[^\s"',;)]{12,}/i,
  },
];

export interface SecretHit {
  label: string;
  field: string;
}

/** Every secret-ish pattern found across the fields that would be committed.
 *  Returns the LABEL and field only — never the matched text, because a report
 *  that reprints the credential defeats its own purpose. */
export function scanForSecrets(record: {
  title?: string;
  content?: string;
  concepts?: string[];
}): SecretHit[] {
  const fields: Array<[string, string]> = [
    ["title", record.title ?? ""],
    ["content", record.content ?? ""],
    ["concepts", (record.concepts ?? []).join(" ")],
  ];
  const hits: SecretHit[] = [];
  for (const [field, text] of fields) {
    if (!text) continue;
    for (const { label, re } of SECRET_PATTERNS) {
      if (re.test(text)) hits.push({ label, field });
    }
  }
  return hits;
}

/**
 * Hash of the file with line endings normalized to LF and trailing whitespace
 * stripped per line.
 *
 * Raw hashes make every cosmetic change look like a lie: run Prettier, bump a
 * license header, or check out on Windows and every memory about that file goes
 * stale while remaining perfectly true. A canon that screams on formatting gets
 * its CI gate deleted within a sprint. Storing both hashes lets verify separate
 * "the code changed" from "the bytes moved", which is the distinction users
 * actually care about.
 */
export function normalizedFileHash(absPath: string): string | null {
  try {
    const text = readFileSync(absPath, "utf8");
    const norm = text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n+$/, "\n");
    return createHash("sha256").update(norm).digest("hex");
  } catch {
    return null;
  }
}

/** Bumped only for breaking record-shape changes; readers must tolerate
 *  unknown extra fields so a newer writer never breaks an older reader. */
export const CANON_FORMAT = 1;
export const CANON_DIR = ".memwarden";
export const CANON_FILE = "canon.jsonl";

export interface CanonRecord {
  format: number;
  id: string;
  title: string;
  content: string;
  concepts: string[];
  /** Repo-relative, forward-slashed, so a canon written on Windows verifies on
   *  Linux and vice versa. */
  files: string[];
  /** file -> capture-time SHA-256. The portable evidence. */
  fileHashes: Record<string, string>;
  /** file -> SHA-256 of the LF-normalized, trailing-whitespace-stripped
   *  content. Lets verify tell "the code changed" from "the bytes moved". */
  fileHashesNormalized?: Record<string, string>;
  type: string;
  /** Which tool/agent produced the underlying memory, when known. Attestation
   *  matters for policy ("trust memories from agents that passed eval X") and
   *  for review ("who taught the repo this?"). */
  capturedBy?: { host?: string; agentId?: string };
  promotedAt: string;
  /** Set by `canon reanchor`: a HUMAN asserted this memory still holds and the
   *  hashes were recomputed against their checkout. Attestation is weaker than
   *  capture-time proof and is reported separately so the two are never
   *  conflated — without it, canon rots permanently after the first refactor
   *  (the original captor's brain is the only thing that could refresh it). */
  reanchoredBy?: string;
  reanchoredAt?: string;
}

export type CanonVerdict =
  /** every listed file is byte-identical to capture time */
  | "verified"
  /** content matches once formatting is normalized — the code did not change */
  | "cosmetic"
  /** a listed file's content genuinely changed, or it is gone */
  | "stale"
  /** no hashes at all: nothing to check, so never treated as good */
  | "missing";

export interface CanonCheck {
  record: CanonRecord;
  verdict: CanonVerdict;
  /** Files that no longer hash-match (stale/cosmetic) or are absent. */
  drifted: string[];
}

export function canonPath(root: string): string {
  return join(root, CANON_DIR, CANON_FILE);
}

/** Repo-relative + forward-slashed. Absolute paths in a committed artifact are
 *  worse than useless: they leak the author's home directory AND fail to
 *  resolve anywhere else. */
export function toRepoRelative(file: string, root: string): string | null {
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  // Outside the repo (or a traversal attempt) has no place in a repo artifact.
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== abs) return null;
  return rel.split(sep).join("/");
}

/** One record per line. Unparseable lines are skipped, not fatal: a
 *  half-resolved merge conflict must never make the whole canon unreadable. */
export function parseCanon(text: string): {
  records: CanonRecord[];
  skipped: number;
} {
  const records: CanonRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s) as CanonRecord;
      if (
        typeof r?.id === "string" &&
        typeof r?.title === "string" &&
        r.fileHashes &&
        typeof r.fileHashes === "object"
      ) {
        records.push(r);
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

export function readCanon(root: string): {
  records: CanonRecord[];
  skipped: number;
  path: string;
  exists: boolean;
} {
  const path = canonPath(root);
  if (!existsSync(path)) {
    return { records: [], skipped: 0, path, exists: false };
  }
  const { records, skipped } = parseCanon(readFileSync(path, "utf8"));
  return { records, skipped, path, exists: true };
}

/**
 * Stable serialization: records sorted by id and keys emitted in a fixed order,
 * so re-running `canon push` on an unchanged brain produces a byte-identical
 * file. Without that, every push would be a spurious diff and reviewers would
 * learn to ignore the artifact — which defeats the entire point of committing it.
 */
export function serializeCanon(records: CanonRecord[]): string {
  const ordered = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = ordered.map((r) => {
    const files = [...r.files].sort();
    const hashes: Record<string, string> = {};
    for (const f of Object.keys(r.fileHashes).sort()) hashes[f] = r.fileHashes[f]!;
    const out: Record<string, unknown> = {
      format: r.format,
      id: r.id,
      type: r.type,
      title: r.title,
      content: r.content,
      concepts: [...r.concepts].sort(),
      files,
      fileHashes: hashes,
      promotedAt: r.promotedAt,
    };
    if (r.fileHashesNormalized) {
      const norm: Record<string, string> = {};
      for (const f of Object.keys(r.fileHashesNormalized).sort()) {
        norm[f] = r.fileHashesNormalized[f]!;
      }
      out["fileHashesNormalized"] = norm;
    }
    if (r.reanchoredBy) out["reanchoredBy"] = r.reanchoredBy;
    if (r.reanchoredAt) out["reanchoredAt"] = r.reanchoredAt;
    if (r.capturedBy && (r.capturedBy.host || r.capturedBy.agentId)) {
      out["capturedBy"] = {
        ...(r.capturedBy.host ? { host: r.capturedBy.host } : {}),
        ...(r.capturedBy.agentId ? { agentId: r.capturedBy.agentId } : {}),
      };
    }
    return JSON.stringify(out);
  });
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

export function writeCanon(root: string, records: CanonRecord[]): string {
  const path = canonPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeCanon(records), "utf8");
  writeCanonReadme(root);
  return path;
}

/**
 * A README beside the canon, for the human who meets this file in code review
 * with no idea what it is. Without it the reasonable reviewer reaction is "this
 * is an unreproducible cache committed to git" — and they would be half right,
 * so the file has to make its own case.
 */
export function writeCanonReadme(root: string): string {
  const path = join(root, CANON_DIR, "README.md");
  if (existsSync(path)) return path; // never clobber a team's own edits
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# .memwarden — the repository's verified memory

\`canon.jsonl\` is an **agent-readable, tamper-evident ARCHITECTURE.md**: decisions
and knowledge your AI coding agents learned while working in this repo, each one
carrying the SHA-256 of every source file it depends on.

It is committed on purpose. Any checkout can re-hash those files and decide for
itself whether a memory still holds:

\`\`\`bash
memwarden canon verify          # verified / cosmetic drift / stale, per memory
memwarden canon verify --strict # exit 1 on real drift (CI gate)
memwarden canon pull            # load what still holds into your local agent memory
\`\`\`

## Reviewing a change to this file

- Each line is one memory. Read it like a doc change, because that is what it is.
- A memory whose source changed is reported **stale** and is refused at recall,
  so a forgotten record misleads nobody — but it should be refreshed or dropped.
- Treat added \`content\` as prose entering the repo's canon: if you would not
  merge it into a design doc, do not merge it here.

## Please protect this path

Records here are ingested by agents. Add to \`CODEOWNERS\` so a human always
reviews changes:

\`\`\`
/.memwarden/  @your-team
\`\`\`

## What a green verdict does and does not mean

A matching hash proves the source file is **unchanged since capture**. It does
not prove the memory's claim is **correct**, and it only covers the files that
were listed at capture time — a memory describing how two modules interact can
be stamped green when only one of them was recorded.

Generated by [memwarden](https://github.com/saiyam1814/memwarden). Safe to edit
by hand; \`canon push\` will not overwrite this README.
`,
    "utf8",
  );
  return path;
}

/**
 * Recompute a record's hashes against THIS checkout and stamp who asserted it.
 *
 * Canon has no self-healing path without this: `push` promotes from the local
 * brain, brains are per-machine, so after a refactor nobody but the original
 * captor could refresh the hashes — and they may have left the team. The
 * result is permanent rot and a CI gate people delete.
 *
 * Re-anchoring is deliberately NOT verification: it records a human claim that
 * the memory still holds, and `verify` reports it as attested so the two are
 * never confused.
 */
export function reanchorRecord(
  record: CanonRecord,
  root: string,
  by: string,
  nowIso: string,
): CanonRecord | null {
  const names = Object.keys(record.fileHashes ?? {});
  if (names.length === 0) return null;
  const fresh = hashFiles(names, root);
  // Every listed file must still exist and be hashable. A memory whose source
  // is gone is not re-anchorable — it is dead, and should be dropped in review.
  const fileHashes: Record<string, string> = {};
  for (const f of names) {
    const h = fresh[f];
    if (!h) return null;
    fileHashes[f] = h;
  }
  const fileHashesNormalized: Record<string, string> = {};
  for (const f of names) {
    const n = normalizedFileHash(resolve(root, f));
    if (n) fileHashesNormalized[f] = n;
  }
  return {
    ...record,
    fileHashes,
    ...(Object.keys(fileHashesNormalized).length > 0
      ? { fileHashesNormalized }
      : {}),
    reanchoredBy: by,
    reanchoredAt: nowIso,
  };
}

/**
 * Re-hash every record's files against THIS checkout and label it. This is the
 * portable firewall verdict: same rule as recall-time classification, computed
 * by whoever holds the repo, with no daemon and no network.
 *
 * A record with no hashes at all cannot be verified and is reported `missing`
 * rather than assumed good — unverifiable must never read as verified.
 */
export function verifyCanon(records: CanonRecord[], root: string): CanonCheck[] {
  return records.map((record) => {
    const expected = record.fileHashes ?? {};
    const names = Object.keys(expected);
    if (names.length === 0) {
      return { record, verdict: "missing" as CanonVerdict, drifted: [] };
    }
    const actual = hashFiles(names, root);
    const expectedNorm = record.fileHashesNormalized ?? {};
    const drifted: string[] = [];
    let cosmeticOnly = true;
    for (const f of names) {
      if (actual[f] === expected[f]) continue;
      drifted.push(f);
      // Cosmetic only when we have a normalized commitment AND it still
      // matches. No normalized hash (older record, or an unreadable file) means
      // we cannot make that claim, so it counts as real drift — unprovable must
      // never round down to harmless.
      const wantNorm = expectedNorm[f];
      const gotNorm = wantNorm ? normalizedFileHash(resolve(root, f)) : null;
      if (!wantNorm || gotNorm !== wantNorm) cosmeticOnly = false;
    }
    const verdict: CanonVerdict =
      drifted.length === 0 ? "verified" : cosmeticOnly ? "cosmetic" : "stale";
    return { record, verdict, drifted };
  });
}

/** Build a canon record from a stored memory, or null when the memory has no
 *  portable evidence. Memories WITHOUT capture-time file hashes are refused on
 *  purpose: promoting them would put unverifiable claims into the repo wearing
 *  the same clothes as verified ones. */
export function recordFromMemory(
  memory: {
    id: string;
    title: string;
    content: string;
    concepts?: string[];
    files?: string[];
    type?: string;
    agentId?: string;
    provenance?: {
      files?: string[];
      fileHashes?: Record<string, string>;
      host?: string;
    };
  },
  root: string,
  nowIso: string,
): CanonRecord | null {
  const hashes = memory.provenance?.fileHashes;
  if (!hashes || Object.keys(hashes).length === 0) return null;

  const fileHashes: Record<string, string> = {};
  for (const [file, hash] of Object.entries(hashes)) {
    const rel = toRepoRelative(file, root);
    if (!rel) continue; // outside the repo: not portable, so not promoted
    fileHashes[rel] = hash;
  }
  if (Object.keys(fileHashes).length === 0) return null;

  const fileHashesNormalized: Record<string, string> = {};
  for (const rel of Object.keys(fileHashes)) {
    const n = normalizedFileHash(resolve(root, rel));
    if (n) fileHashesNormalized[rel] = n;
  }

  return {
    format: CANON_FORMAT,
    id: memory.id,
    type: memory.type ?? "fact",
    title: memory.title,
    content: memory.content,
    concepts: memory.concepts ?? [],
    files: Object.keys(fileHashes),
    fileHashes,
    ...(Object.keys(fileHashesNormalized).length > 0
      ? { fileHashesNormalized }
      : {}),
    ...(memory.provenance?.host || memory.agentId
      ? {
          capturedBy: {
            ...(memory.provenance?.host ? { host: memory.provenance.host } : {}),
            ...(memory.agentId ? { agentId: memory.agentId } : {}),
          },
        }
      : {}),
    promotedAt: nowIso,
  };
}
