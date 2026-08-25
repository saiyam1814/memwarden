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
  mergeCanonRecords,
  parseCanon,
  readCanon,
  recordFromMemory,
  reanchorRecord,
  scanForSecrets,
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

  it("writes a README for the human who meets this file in review", () => {
    writeRepoFile("a.ts", "1\n");
    const rec = recordFromMemory(memoryFor("a.ts", "first", "mem_a"), repo, new Date().toISOString())!;
    writeCanon(repo, [rec]);
    const readme = readFileSync(join(repo, ".memwarden/README.md"), "utf8");
    expect(readme).toContain("CODEOWNERS");
    // The honesty boundary must survive into the artifact itself, not just docs.
    expect(readme).toContain("unchanged since capture");
  });

  it("merges by default so Canon-only team records survive; replace is explicit", () => {
    writeRepoFile("a.ts", "1\n");
    const now = new Date().toISOString();
    const team = recordFromMemory(memoryFor("a.ts", "team-only", "mem_team"), repo, now)!;
    const local = recordFromMemory(memoryFor("a.ts", "local", "mem_local"), repo, now)!;

    expect(mergeCanonRecords([team], [local]).map((r) => r.id).sort()).toEqual([
      "mem_local",
      "mem_team",
    ]);
    expect(mergeCanonRecords([team], [local], "replace").map((r) => r.id)).toEqual([
      "mem_local",
    ]);
  });

  it("never derives a normalized capture commitment from already-stale bytes", () => {
    writeRepoFile("src/policy.ts", "export const POLICY = 'old';\n");
    const memory = memoryFor("src/policy.ts", "policy is old");
    writeRepoFile("src/policy.ts", "export const POLICY = 'new';\n");

    const record = recordFromMemory(memory, repo, new Date().toISOString())!;
    expect(record.fileHashesNormalized).toBeUndefined();
    expect(verifyCanon([record], repo)[0]!.verdict).toBe("stale");
  });

  it("refuses mixed/incomplete evidence instead of promoting a verified subset", () => {
    writeRepoFile("src/a.ts", "a\n");
    const memory = memoryFor("src/a.ts", "claim spans more than its evidence");
    expect(
      recordFromMemory(
        { ...memory, provenance: { ...memory.provenance, mixedTrust: true } },
        repo,
        new Date().toISOString(),
      ),
    ).toBeNull();
  });

  it("skips a traversal-bearing record before verification can read outside the repo", () => {
    const malicious = {
      format: CANON_FORMAT,
      id: "mem_escape",
      type: "fact",
      title: "escape",
      content: "x",
      concepts: [],
      files: ["../outside.txt"],
      fileHashes: { "../outside.txt": "a".repeat(64) },
      promotedAt: new Date().toISOString(),
    };
    const parsed = parseCanon(JSON.stringify(malicious));
    expect(parsed.records).toEqual([]);
    expect(parsed.skipped).toBe(1);
  });
});

// The canon is COMMITTED, and git history is a one-way door. A credential that
// reaches it is an incident and a history rewrite, not a delete — so this gate
// has no override, and `--all` (staleness) must never be mistaken for one.
describe("canon secret gate", () => {
  const cases: Array<[string, string]> = [
    ["AWS access key id", "creds are AKIAIOSFODNN7EXAMPLE for the bucket"],
    ["GitHub token", "use ghp_" + "a".repeat(36) + " to push"],
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n"],
    ["Anthropic API key", "key is sk-ant-" + "b".repeat(24)],
    ["OpenRouter key", "key is sk-or-v1-" + "c".repeat(32)],
    ["JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk"],
    [
      "credentialed connection string",
      "DB is postgres://admin:hunter2@db.internal:5432/app",
    ],
    ["assigned credential", 'config has api_key = "swordfish-abcdef123456"'],
  ];

  for (const [label, text] of cases) {
    it(`detects ${label}`, () => {
      const hits = scanForSecrets({ title: "config note", content: text, concepts: [] });
      expect(hits.map((h) => h.label)).toContain(label);
    });
  }

  it("does not fire on ordinary engineering prose", () => {
    const benign = [
      "refresh tokens rotate every 15 minutes, enforced in src/auth.ts",
      "the password reset flow sends an email; see resetPassword()",
      "we store the API key in the secret manager, never in the repo",
      "commit 9f2c1ab4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0 broke the build",
    ];
    for (const content of benign) {
      expect(scanForSecrets({ title: "note", content, concepts: [] })).toEqual([]);
    }
  });

  it("reports the field but NEVER the matched secret text", () => {
    const secret = "ghp_" + "z".repeat(36);
    const hits = scanForSecrets({ title: "t", content: `token ${secret}`, concepts: [] });
    expect(hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(hits)).not.toContain(secret);
    expect(hits[0]!.field).toBe("content");
  });

  it("scans title and concepts, not just content", () => {
    expect(
      scanForSecrets({ title: "AKIAIOSFODNN7EXAMPLE", content: "", concepts: [] }).length,
    ).toBeGreaterThan(0);
    expect(
      scanForSecrets({ title: "t", content: "", concepts: ["AKIAIOSFODNN7EXAMPLE"] }).length,
    ).toBeGreaterThan(0);
  });
});

// Raw hashes make every reformat look like a lie. A canon that screams on
// Prettier gets its CI gate deleted, so formatting-only change is its own state.
describe("canon drift severity", () => {
  it("calls a formatting-only change COSMETIC, not stale", () => {
    writeRepoFile("src/auth.ts", "export const A = 1;\nexport const B = 2;\n");
    const rec = recordFromMemory(
      memoryFor("src/auth.ts", "A and B are constants"),
      repo,
      new Date().toISOString(),
    )!;
    expect(rec.fileHashesNormalized?.["src/auth.ts"]).toBeTruthy();

    // CRLF + trailing whitespace: bytes moved, code did not.
    writeRepoFile("src/auth.ts", "export const A = 1;   \r\nexport const B = 2;\t\r\n");
    const [check] = verifyCanon([rec], repo);
    expect(check!.verdict).toBe("cosmetic");
    expect(check!.drifted).toEqual(["src/auth.ts"]);
  });

  it("still calls a real code change STALE", () => {
    writeRepoFile("src/auth.ts", "export const ROTATE = 900_000;\n");
    const rec = recordFromMemory(
      memoryFor("src/auth.ts", "rotation is 15m"),
      repo,
      new Date().toISOString(),
    )!;
    writeRepoFile("src/auth.ts", "export const ROTATE = 3_600_000;\n");
    expect(verifyCanon([rec], repo)[0]!.verdict).toBe("stale");
  });

  it("treats a record with no normalized hash as drifted, never cosmetic", () => {
    // Unprovable must not round down to harmless: an older record without a
    // normalized commitment cannot claim "only formatting changed".
    writeRepoFile("a.ts", "x\n");
    const rec = recordFromMemory(memoryFor("a.ts", "note"), repo, new Date().toISOString())!;
    delete rec.fileHashesNormalized;
    writeRepoFile("a.ts", "x   \r\n");
    expect(verifyCanon([rec], repo)[0]!.verdict).toBe("stale");
  });
});

// Without re-anchoring, canon has no maintenance path: push promotes from the
// LOCAL brain, brains are per-machine, so after a refactor nobody but the
// original captor could refresh the hashes — and they may have left the team.
describe("canon reanchor", () => {
  it("recomputes hashes against this checkout and records WHO asserted it", () => {
    writeRepoFile("src/auth.ts", "export const ROTATE = 900_000;\n");
    const rec = recordFromMemory(
      memoryFor("src/auth.ts", "rotation policy lives here"),
      repo,
      new Date().toISOString(),
    )!;
    writeRepoFile("src/auth.ts", "export const ROTATE = 3_600_000;\n");
    expect(verifyCanon([rec], repo)[0]!.verdict).toBe("stale");

    const next = reanchorRecord(rec, repo, "alice", new Date().toISOString())!;
    expect(next.reanchoredBy).toBe("alice");
    expect(next.reanchoredAt).toBeTruthy();
    // Now it verifies — but the attestation is on the record, so verify can
    // report it as asserted rather than proven from capture.
    expect(verifyCanon([next], repo)[0]!.verdict).toBe("verified");
  });

  it("refuses to re-anchor a record whose files are gone", () => {
    writeRepoFile("src/gone.ts", "x\n");
    const rec = recordFromMemory(memoryFor("src/gone.ts", "note"), repo, new Date().toISOString())!;
    rmSync(join(repo, "src/gone.ts"));
    // A memory whose source no longer exists is dead, not re-anchorable.
    expect(reanchorRecord(rec, repo, "alice", new Date().toISOString())).toBeNull();
  });

  it("keeps attestation through serialization", () => {
    writeRepoFile("a.ts", "1\n");
    const rec = recordFromMemory(memoryFor("a.ts", "note"), repo, new Date().toISOString())!;
    const anchored = reanchorRecord(rec, repo, "bob", new Date().toISOString())!;
    const { records } = parseCanon(serializeCanon([anchored]));
    expect(records[0]!.reanchoredBy).toBe("bob");
  });
});
