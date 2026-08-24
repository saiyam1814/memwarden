//
// Verified Memory Canon: the portable half of Verified Recall.
//
// The property under test is the one that makes the format worth committing:
// a record written on one machine must reach the SAME verdict on any other
// checkout, computed locally from repo-relative paths and capture-time hashes.
// Everything else here defends that: byte-stable output (so reviewers trust the
// diff), refusal to promote unverifiable memory, no absolute paths leaking into
// a committed artifact, and survival of a merge-mangled line.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CANON_FORMAT,
  canonPath,
  parseCanon,
  readCanon,
  recordFromMemory,
  serializeCanon,
  toRepoRelative,
  verifyCanon,
  writeCanon,
  type CanonRecord,
} from "../src/cli/canon.js";

let repo: string;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function writeRepoFile(rel: string, content: string): string {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-canon-")));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** A memory as the brain stores it: provenance carries the capture-time hash. */
function memoryFor(rel: string, content: string, id = "mem_1") {
  const abs = join(repo, rel);
  return {
    id,
    title: `Decision about ${rel}`,
    content,
    concepts: ["auth"],
    type: "architecture",
    files: [abs],
    provenance: {
      files: [abs],
      fileHashes: { [abs]: sha256(readFileSync(abs, "utf8")) },
      host: "claude-code",
    },
  };
}

describe("canon: portable verified memory", () => {
  it("promotes a hash-backed memory and verifies green against the same checkout", () => {
    writeRepoFile("src/auth.ts", "export const ROTATE_MS = 900_000;\n");
    const rec = recordFromMemory(
      memoryFor("src/auth.ts", "refresh tokens rotate every 15m"),
      repo,
      new Date().toISOString(),
    );
    expect(rec).not.toBeNull();
    expect(rec!.format).toBe(CANON_FORMAT);
    // The whole point: a committed artifact must not carry the author's paths.
    expect(rec!.files).toEqual(["src/auth.ts"]);
    expect(JSON.stringify(rec)).not.toContain(repo);

    const [check] = verifyCanon([rec!], repo);
    expect(check!.verdict).toBe("verified");
    expect(check!.drifted).toEqual([]);
  });

  it("flags STALE when the referenced file changes — the portable firewall verdict", () => {
    writeRepoFile("src/auth.ts", "export const ROTATE_MS = 900_000;\n");
    const rec = recordFromMemory(
      memoryFor("src/auth.ts", "refresh tokens rotate every 15m"),
      repo,
      new Date().toISOString(),
    )!;

    // Someone changes the rotation policy. The memory now lies.
    writeRepoFile("src/auth.ts", "export const ROTATE_MS = 3_600_000;\n");

    const [check] = verifyCanon([rec], repo);
    expect(check!.verdict).toBe("stale");
    expect(check!.drifted).toEqual(["src/auth.ts"]);
  });

  it("flags STALE when the referenced file is deleted", () => {
    writeRepoFile("src/gone.ts", "x\n");
    const rec = recordFromMemory(
      memoryFor("src/gone.ts", "this module owns retries"),
      repo,
      new Date().toISOString(),
    )!;
    rmSync(join(repo, "src/gone.ts"));

    const [check] = verifyCanon([rec], repo);
    expect(check!.verdict).toBe("stale");
    expect(check!.drifted).toEqual(["src/gone.ts"]);
  });

  it("verifies identically on a DIFFERENT checkout path (portability)", () => {
    writeRepoFile("src/auth.ts", "export const ROTATE_MS = 900_000;\n");
    const rec = recordFromMemory(
      memoryFor("src/auth.ts", "refresh tokens rotate every 15m"),
      repo,
      new Date().toISOString(),
    )!;

    // Simulate a teammate's clone at a completely different path.
    const clone = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-clone-")));
    try {
      mkdirSync(join(clone, "src"), { recursive: true });
      writeFileSync(join(clone, "src/auth.ts"), "export const ROTATE_MS = 900_000;\n");
      const [check] = verifyCanon([rec], clone);
      expect(check!.verdict).toBe("verified");

      // ...and drifts independently there.
      writeFileSync(join(clone, "src/auth.ts"), "changed\n");
      expect(verifyCanon([rec], clone)[0]!.verdict).toBe("stale");
      // The original checkout is unaffected — each checkout judges for itself.
      expect(verifyCanon([rec], repo)[0]!.verdict).toBe("verified");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("REFUSES to promote a memory with no capture-time hashes", () => {
    // Adopted/hashless memory has nothing portable to prove. Committing it
    // would put an unverifiable claim in the repo dressed as a verified one.
    const rec = recordFromMemory(
      {
        id: "mem_x",
        title: "vague lore",
        content: "we prefer tabs",
        provenance: { files: ["src/whatever.ts"] },
      },
      repo,
      new Date().toISOString(),
    );
    expect(rec).toBeNull();
  });

  it("refuses paths outside the repo instead of leaking them", () => {
    expect(toRepoRelative("/etc/passwd", repo)).toBeNull();
    expect(toRepoRelative(join(repo, "../escape.ts"), repo)).toBeNull();
    expect(toRepoRelative(join(repo, "src/in.ts"), repo)).toBe("src/in.ts");

    // A memory whose only evidence lives outside the repo is not promotable.
    const rec = recordFromMemory(
      {
        id: "mem_out",
        title: "outside",
        content: "x",
        provenance: { files: ["/etc/passwd"], fileHashes: { "/etc/passwd": "a".repeat(64) } },
      },
      repo,
      new Date().toISOString(),
    );
    expect(rec).toBeNull();
  });

  it("serializes byte-identically for unchanged input (so diffs mean something)", () => {
    writeRepoFile("a.ts", "1\n");
    writeRepoFile("b.ts", "2\n");
    const now = new Date().toISOString();
    const recs = [
      recordFromMemory(memoryFor("b.ts", "second", "mem_b"), repo, now)!,
      recordFromMemory(memoryFor("a.ts", "first", "mem_a"), repo, now)!,
    ];
    const once = serializeCanon(recs);
    // Reordered input must produce the same bytes: sorted by id, fixed keys.
    const twice = serializeCanon([...recs].reverse());
    expect(twice).toBe(once);
    // And it round-trips.
    const { records, skipped } = parseCanon(once);
    expect(skipped).toBe(0);
    expect(records.map((r) => r.id)).toEqual(["mem_a", "mem_b"]);
  });

  it("survives a merge-mangled line instead of failing the whole canon", () => {
    writeRepoFile("a.ts", "1\n");
    const rec = recordFromMemory(memoryFor("a.ts", "first", "mem_a"), repo, new Date().toISOString())!;
    const text =
      serializeCanon([rec]) +
      "<<<<<<< HEAD\n" +
      '{"id": broken json\n' +
      ">>>>>>> other\n";
    const { records, skipped } = parseCanon(text);
    expect(records).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it("reports a hashless record as UNVERIFIABLE, never as verified", () => {
    const rec: CanonRecord = {
      format: CANON_FORMAT,
      id: "mem_empty",
      type: "fact",
      title: "no evidence",
      content: "x",
      concepts: [],
      files: [],
      fileHashes: {},
      promotedAt: new Date().toISOString(),
    };
    expect(verifyCanon([rec], repo)[0]!.verdict).toBe("missing");
  });

  it("writes and reads the canon at .memwarden/canon.jsonl", () => {
    writeRepoFile("a.ts", "1\n");
    const rec = recordFromMemory(memoryFor("a.ts", "first", "mem_a"), repo, new Date().toISOString())!;
    const path = writeCanon(repo, [rec]);
    expect(path).toBe(canonPath(repo));

    const back = readCanon(repo);
    expect(back.exists).toBe(true);
    expect(back.records).toHaveLength(1);
    expect(back.records[0]!.content).toBe("first");
  });

  it("reports a missing canon as absent rather than empty-and-fine", () => {
    const back = readCanon(repo);
    expect(back.exists).toBe(false);
    expect(back.records).toEqual([]);
  });
});
