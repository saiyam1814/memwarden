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
import { dirname, join, relative, resolve, sep } from "node:path";
import { hashFiles } from "../functions/verify.js";

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
  type: string;
  /** Which tool/agent produced the underlying memory, when known. Attestation
   *  matters for policy ("trust memories from agents that passed eval X") and
   *  for review ("who taught the repo this?"). */
  capturedBy?: { host?: string; agentId?: string };
  promotedAt: string;
}

export type CanonVerdict = "verified" | "stale" | "missing";

export interface CanonCheck {
  record: CanonRecord;
  verdict: CanonVerdict;
  /** Files that no longer hash-match (verdict stale) or are absent (missing). */
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
  return path;
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
    const drifted: string[] = [];
    for (const f of names) {
      // Absent (unhashable) and changed are both drift for our purposes; the
      // caller distinguishes them in prose, not in the verdict.
      if (actual[f] !== expected[f]) drifted.push(f);
    }
    return {
      record,
      verdict: drifted.length === 0 ? "verified" : "stale",
      drifted,
    };
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

  return {
    format: CANON_FORMAT,
    id: memory.id,
    type: memory.type ?? "fact",
    title: memory.title,
    content: memory.content,
    concepts: memory.concepts ?? [],
    files: Object.keys(fileHashes),
    fileHashes,
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
