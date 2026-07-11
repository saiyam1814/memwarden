//
// Verified Recall: the classifier (verified / sourced_unverified / stale /
// unsourced, including content drift) and the recall firewall end to end —
// capture a memory that references a real file, recall it, then change the
// file and confirm safe_only recall drops it while plain search still returns it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { StateKV } from "../src/state/kv.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import { classifyProvenance, hashFiles } from "../src/functions/verify.js";
import type { Provenance } from "../src/functions/types.js";

let sdk: Kernel;
const dirs: string[] = [];

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-verify" }, {
    store: new StoreLibsql({ url: ":memory:" }),
  });
  registerCoreFunctions(sdk, new StateKV(sdk));
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  __resetKernelSingleton();
});

function repo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-verify-")));
  dirs.push(d);
  return d;
}

describe("classifyProvenance", () => {
  it("verifyAgainstRoot checks the caller's checkout, not the capture dir", () => {
    // Same project, two checkouts: captured in A, recalled from B.
    const a = repo();
    const b = repo();
    writeFileSync(join(a, "auth.ts"), "const ttl = 900;\n");
    const prov: Provenance = {
      cwd: a,
      files: ["auth.ts"],
      fileHashes: hashFiles(["auth.ts"], a),
    };

    // Default (no proven identity): verified against A regardless of B.
    expect(classifyProvenance(prov, b).status).toBe("verified");

    // Proven same-project: B lacks the file -> stale FOR B (the checkout the
    // agent is actually looking at), even though A still matches.
    expect(
      classifyProvenance(prov, b, { verifyAgainstRoot: true }).status,
    ).toBe("stale");

    // B has the identical content -> verified for B.
    writeFileSync(join(b, "auth.ts"), "const ttl = 900;\n");
    expect(
      classifyProvenance(prov, b, { verifyAgainstRoot: true }).status,
    ).toBe("verified");

    // B diverged -> stale for B while A would still pass.
    writeFileSync(join(b, "auth.ts"), "const ttl = 60;\n");
    expect(
      classifyProvenance(prov, b, { verifyAgainstRoot: true }).status,
    ).toBe("stale");
    expect(classifyProvenance(prov, b).status).toBe("verified");
  });

  it("verifyAgainstRoot re-roots ABSOLUTE files captured under the capture cwd (worktree false-verified)", () => {
    // F1 repro: capture in worktree A recorded an ABSOLUTE path into A. When
    // recall proves same-project identity and asks to verify against worktree
    // B, the absolute path must be re-rooted onto B — otherwise B's diverged
    // copy still reports "verified" because the check silently reads A.
    const a = repo();
    const b = repo();
    writeFileSync(join(a, "auth.ts"), "const ttl = 900;\n");
    const absFile = join(a, "auth.ts");
    const prov: Provenance = {
      cwd: a,
      files: [absFile],
      fileHashes: hashFiles([absFile], a),
    };

    // B lacks the file -> stale FOR B (was: false "verified" against A).
    expect(
      classifyProvenance(prov, b, { verifyAgainstRoot: true }).status,
    ).toBe("stale");

    // B has identical content -> verified for B.
    writeFileSync(join(b, "auth.ts"), "const ttl = 900;\n");
    expect(
      classifyProvenance(prov, b, { verifyAgainstRoot: true }).status,
    ).toBe("verified");

    // B diverged -> stale for B even though A still matches (the F1 bug).
    writeFileSync(join(b, "auth.ts"), "const ttl = 60;\n");
    expect(
      classifyProvenance(prov, b, { verifyAgainstRoot: true }).status,
    ).toBe("stale");

    // Without proven identity: still verified against the capture checkout.
    expect(classifyProvenance(prov, b).status).toBe("verified");
  });

  it("verifyAgainstRoot leaves absolute files OUTSIDE the capture cwd alone (cross-project protection)", () => {
    const a = repo();
    const b = repo();
    const elsewhere = repo();
    writeFileSync(join(elsewhere, "lib.ts"), "shared\n");
    const absFile = join(elsewhere, "lib.ts");
    const prov: Provenance = {
      cwd: a,
      files: [absFile],
      fileHashes: hashFiles([absFile], a),
    };
    // The file is not under the capture cwd, so re-rooting must NOT apply:
    // it verifies where it actually lives, regardless of the caller's root.
    expect(
      classifyProvenance(prov, b, { verifyAgainstRoot: true }).status,
    ).toBe("verified");
    writeFileSync(join(elsewhere, "lib.ts"), "changed\n");
    expect(
      classifyProvenance(prov, b, { verifyAgainstRoot: true }).status,
    ).toBe("stale");
  });

  it("unsourced when there is no evidence", () => {
    expect(classifyProvenance(undefined, "/r").status).toBe("unsourced");
    expect(classifyProvenance({ userConfirmed: false }, "/r").status).toBe("unsourced");
  });

  it("sourced_unverified (not verified) for command-only, file-less captures", () => {
    const p: Provenance = { command: "Bash: npm test" };
    expect(classifyProvenance(p, "/r").status).toBe("sourced_unverified");
  });

  it("sourced_unverified when files exist but were never hashed", () => {
    const root = repo();
    writeFileSync(join(root, "c.ts"), "x\n");
    const p: Provenance = { files: ["c.ts"], command: "Edit" }; // no fileHashes
    expect(classifyProvenance(p, root).status).toBe("sourced_unverified");
  });

  it("sourced_unverified when only SOME referenced files were content-checked", () => {
    const root = repo();
    writeFileSync(join(root, "small.ts"), "x\n");
    writeFileSync(join(root, "other.ts"), "y\n"); // exists but never hashed (e.g. too large)
    const p: Provenance = {
      files: ["small.ts", "other.ts"],
      fileHashes: hashFiles(["small.ts"], root), // only small.ts hashed
    };
    // One matching hash must NOT vouch for the unchecked file.
    expect(classifyProvenance(p, root).status).toBe("sourced_unverified");
  });

  it("verified when the referenced file exists and its hash still matches", () => {
    const root = repo();
    writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
    const p: Provenance = { files: ["a.ts"], fileHashes: hashFiles(["a.ts"], root) };
    expect(classifyProvenance(p, root).status).toBe("verified");
  });

  it("stale when the referenced file is gone", () => {
    const root = repo();
    const p: Provenance = { files: ["ghost.ts"], command: "Edit" };
    const v = classifyProvenance(p, root);
    expect(v.status).toBe("stale");
    expect(v.reason).toMatch(/deleted/);
  });

  it("resolves relative files against provenance.cwd, not the caller's root", () => {
    // Two projects, each with their own src/auth.ts of different content. A
    // memory captured in projectA must verify against projectA's file even
    // when classified while the caller is "in" projectB — never produce a
    // false verdict from a same-named file in the wrong repo.
    const projectA = repo();
    const projectB = repo();
    mkdirSync(join(projectA, "src"), { recursive: true });
    mkdirSync(join(projectB, "src"), { recursive: true });
    writeFileSync(join(projectA, "src", "auth.ts"), "A: bearer tokens\n");
    writeFileSync(join(projectB, "src", "auth.ts"), "B: totally different\n");
    const p: Provenance = {
      cwd: projectA,
      files: ["src/auth.ts"],
      fileHashes: hashFiles(["src/auth.ts"], projectA),
    };
    // classify "from" projectB — must still verify against projectA's file
    expect(classifyProvenance(p, projectB).status).toBe("verified");
    // and if projectA's file drifts, it goes stale regardless of projectB
    writeFileSync(join(projectA, "src", "auth.ts"), "A: changed\n");
    expect(classifyProvenance(p, projectB).status).toBe("stale");
  });

  it("stale when the referenced file's content changed", () => {
    const root = repo();
    writeFileSync(join(root, "b.ts"), "v1\n");
    const p: Provenance = { files: ["b.ts"], fileHashes: hashFiles(["b.ts"], root) };
    writeFileSync(join(root, "b.ts"), "v2 — changed\n"); // content drift
    const v = classifyProvenance(p, root);
    expect(v.status).toBe("stale");
    expect(v.reason).toMatch(/changed/);
  });
});

describe("Verified Recall firewall (safe_only)", () => {
  async function observe(
    root: string,
    file: string,
    output: string,
    sessionId = "s1",
    timestamp = new Date().toISOString(),
  ) {
    return sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId,
        project: root,
        cwd: root,
        timestamp,
        data: { tool_name: "Edit", tool_input: { file_path: file }, tool_output: output },
      },
    });
  }
  async function search(root: string, safeOnly: boolean): Promise<number> {
    const r = (await sdk.trigger({
      function_id: "mem::search",
      payload: { query: "bearer auth tokens", cwd: root, project: root, limit: 10, safe_only: safeOnly },
    })) as { results: unknown[] };
    return r.results.length;
  }

  it("MEMWARDEN_RECALL_POLICY=verified-only refuses everything not hash-verified", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "auth.ts"), "// bearer auth tokens, 1h TTL\n");
    // One verified memory (file-backed) and one unsourced one (no evidence).
    await observe(root, "src/auth.ts", "auth uses bearer tokens with a 1h TTL");
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "s1",
        project: root,
        cwd: root,
        timestamp: new Date().toISOString(),
        data: { tool_name: "Bash", tool_input: { command: "true" }, tool_output: "someone said bearer auth tokens are being replaced" },
      },
    });

    // balanced (default): both are recallable under safe_only.
    expect(await search(root, true)).toBeGreaterThanOrEqual(2);

    // verified-only: just the hash-verified one survives auto-injection.
    process.env.MEMWARDEN_RECALL_POLICY = "verified-only";
    try {
      expect(await search(root, true)).toBe(1);
      // Explicit unfiltered lookups are never policy-filtered.
      expect(await search(root, false)).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.MEMWARDEN_RECALL_POLICY;
    }
  });

  it("recalls a verified memory, then drops it once its file drifts", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "auth.ts"), "// bearer auth tokens, 1h TTL\n");
    await observe(root, "src/auth.ts", "auth uses bearer tokens with a 1h TTL");

    // Verified: file present + hash matches what was captured.
    expect(await search(root, true)).toBeGreaterThan(0);

    // The code changes out from under the memory.
    writeFileSync(join(root, "src", "auth.ts"), "// totally rewritten auth\n");

    // safe_only recall now firewalls the stale memory...
    expect(await search(root, true)).toBe(0);
    // ...but a plain (unverified) search still returns it.
    expect(await search(root, false)).toBeGreaterThan(0);
  });

  it("does not let stale top hits starve a lower-ranked verified result", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    // A verified memory that ranks LAST (only one query term).
    writeFileSync(join(root, "src", "keep.ts"), "// keep\n");
    await observe(root, "src/keep.ts", "bearer");
    // Two higher-scoring memories (more query terms) whose files then vanish.
    for (const id of ["a", "b"]) {
      writeFileSync(join(root, "src", `${id}.ts`), "tmp\n");
      await observe(root, `src/${id}.ts`, "bearer auth tokens galore galore");
    }
    rmSync(join(root, "src", "a.ts"));
    rmSync(join(root, "src", "b.ts"));

    // With limit=2 the two stale memories fill the top slots; the firewall
    // must backfill the verified one rather than return nothing.
    const r = (await sdk.trigger({
      function_id: "mem::search",
      payload: { query: "bearer auth tokens galore", cwd: root, project: root, limit: 2, safe_only: true },
    })) as { results: unknown[] };
    expect(r.results.length).toBe(1);
  });

  it("does NOT silently drop conflicting memories from safe recall (both are kept, no conflicts_dropped)", async () => {
    // A trust tool must never lose a correct fact on a fuzzy contradiction
    // heuristic. safe_only only firewalls STALE memory; conflicting-but-fresh
    // memories both survive recall (conflict reporting is doctor-only).
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "runtime.ts"), "export const runtime = 'current';\n");

    await observe(root, "src/runtime.ts", "runtime uses node 22", "s1", "2026-01-01T00:00:00.000Z");
    await observe(root, "src/runtime.ts", "runtime uses bun runtime", "s2", "2026-01-02T00:00:00.000Z");

    const safe = (await sdk.trigger({
      function_id: "mem::search",
      payload: { query: "runtime uses", cwd: root, project: root, limit: 10, safe_only: true },
    })) as {
      results: Array<{ observation: { narrative: string } }>;
      conflicts_dropped?: number;
    };

    // No conflict-based dropping: both memories are returned, and the field is
    // gone from the contract entirely.
    expect(safe.conflicts_dropped).toBeUndefined();
    expect(safe.results.length).toBe(2);
    const narratives = safe.results.map((r) => r.observation.narrative).join(" ");
    expect(narratives).toContain("bun runtime");
    expect(narratives).toContain("node 22");

    const plain = (await sdk.trigger({
      function_id: "mem::search",
      payload: { query: "runtime uses", cwd: root, project: root, limit: 10 },
    })) as { results: unknown[] };
    expect(plain.results.length).toBe(2);
  });
});
