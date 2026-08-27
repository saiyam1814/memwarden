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
import {
  classifyProvenance,
  hashFileCommitments,
  hashFiles,
} from "../src/functions/verify.js";
import { extractProvenance } from "../src/functions/provenance.js";
import { summarizeFirewall } from "../src/functions/firewall-stats.js";
import type { Provenance } from "../src/functions/types.js";

let sdk: Kernel;
let kv: StateKV;
const dirs: string[] = [];

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-verify" }, {
    store: new StoreLibsql({ url: ":memory:" }),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
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

  it("treats LF capture and CRLF recall as cosmetic/current without losing the raw commitment", () => {
    const capture = repo();
    const checkout = repo();
    writeFileSync(join(capture, "policy.ts"), "export const TTL = 15;\n");
    writeFileSync(join(checkout, "policy.ts"), "export const TTL = 15;\r\n");
    const commitments = hashFileCommitments(["policy.ts"], capture);
    const prov: Provenance = {
      cwd: capture,
      files: ["policy.ts"],
      ...commitments,
    };

    expect(commitments.fileHashes["policy.ts"]).toBeDefined();
    expect(commitments.fileHashesNormalized["policy.ts"]).toBeDefined();
    expect(hashFiles(["policy.ts"], checkout)["policy.ts"]).not.toBe(
      commitments.fileHashes["policy.ts"],
    );
    expect(classifyProvenance(prov, capture).status).toBe("verified");
    const cosmetic = classifyProvenance(prov, checkout, {
      verifyAgainstRoot: true,
    });
    expect(cosmetic.status).toBe("cosmetic");
    expect(cosmetic.reason).toMatch(/line endings|trailing whitespace/);

    writeFileSync(join(checkout, "policy.ts"), "export const TTL = 60;\r\n");
    expect(
      classifyProvenance(prov, checkout, { verifyAgainstRoot: true }).status,
    ).toBe("stale");
  });

  it("never lets normalized subset evidence certify mixed or incomplete content", () => {
    const capture = repo();
    const checkout = repo();
    for (const root of [capture, checkout]) {
      writeFileSync(
        join(root, "policy.ts"),
        root === capture ? "policy\n" : "policy\r\n",
      );
      writeFileSync(join(root, "unchecked.ts"), "unchecked\n");
    }
    const commitments = hashFileCommitments(["policy.ts"], capture);
    const mixed: Provenance = {
      cwd: capture,
      files: ["policy.ts"],
      ...commitments,
      mixedTrust: true,
    };
    expect(
      classifyProvenance(mixed, checkout, { verifyAgainstRoot: true }).status,
    ).toBe("sourced_unverified");

    const incomplete: Provenance = {
      cwd: capture,
      files: ["policy.ts", "unchecked.ts"],
      ...commitments,
    };
    expect(
      classifyProvenance(incomplete, checkout, { verifyAgainstRoot: true })
        .status,
    ).toBe("sourced_unverified");
  });

  it("does not create normalized commitments for binary evidence", () => {
    const capture = repo();
    const checkout = repo();
    writeFileSync(join(capture, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(checkout, "blob.bin"), Buffer.from([0, 1, 2, 4]));
    const commitments = hashFileCommitments(["blob.bin"], capture);
    expect(commitments.fileHashes["blob.bin"]).toBeDefined();
    expect(commitments.fileHashesNormalized).toEqual({});
    expect(
      classifyProvenance(
        { cwd: capture, files: ["blob.bin"], ...commitments },
        checkout,
        { verifyAgainstRoot: true },
      ).status,
    ).toBe("stale");
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
    const beforeStrict = await summarizeFirewall(kv);

    // verified-only: just the hash-verified one survives auto-injection.
    process.env.MEMWARDEN_RECALL_POLICY = "verified-only";
    try {
      expect(await search(root, true)).toBe(1);
      const afterStrict = await summarizeFirewall(kv);
      expect(afterStrict.injected - beforeStrict.injected).toBe(1);
      expect(afterStrict.served.verified - beforeStrict.served.verified).toBe(1);
      expect(afterStrict.served.cosmetic - beforeStrict.served.cosmetic).toBe(0);
      expect(afterStrict.served.sourced - beforeStrict.served.sourced).toBe(0);
      expect(afterStrict.served.unsourced - beforeStrict.served.unsourced).toBe(0);
      expect(afterStrict.refused - beforeStrict.refused).toBe(1);
      // Explicit unfiltered lookups are never policy-filtered or counted.
      expect(await search(root, false)).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.MEMWARDEN_RECALL_POLICY;
    }
  });

  it("keeps normalized-content-current memory under verified-only with cosmetic labels", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "auth.ts"), "// bearer auth tokens\n");
    await observe(root, "src/auth.ts", "auth uses bearer auth tokens");
    writeFileSync(join(root, "src", "auth.ts"), "// bearer auth tokens\r\n");

    process.env.MEMWARDEN_RECALL_POLICY = "verified-only";
    try {
      const result = (await sdk.trigger({
        function_id: "mem::search",
        payload: {
          query: "bearer auth tokens",
          cwd: root,
          project: root,
          limit: 10,
          safe_only: true,
          format: "compact",
        },
      })) as {
        results: Array<{ trust: string; source_status: string; historical: boolean }>;
      };
      expect(result.results).toEqual([
        expect.objectContaining({
          trust: "cosmetic",
          source_status: "source-cosmetic",
          historical: false,
        }),
      ]);
      expect((await summarizeFirewall(kv)).served).toEqual({
        verified: 0,
        cosmetic: 1,
        sourced: 0,
        unsourced: 0,
        legacyUnclassified: 0,
      });
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
    // ...and surfaces refusal evidence so hooks can show the firewall working.
    const blocked = (await sdk.trigger({
      function_id: "mem::search",
      payload: {
        query: "bearer",
        cwd: root,
        project: root,
        limit: 5,
        safe_only: true,
        format: "narrative",
      },
    })) as {
      text?: string;
      firewall?: {
        refused: number;
        samples: Array<{ obsId?: string; title?: string; reason?: string }>;
      };
    };
    expect(blocked.firewall?.refused).toBeGreaterThan(0);
    expect(blocked.firewall?.samples?.length).toBeGreaterThan(0);
    // Evidence, not content: samples carry the id + reason, never the title.
    expect(blocked.firewall?.samples?.[0]?.obsId).toBeTruthy();
    expect(blocked.firewall?.samples?.[0]?.title).toBeUndefined();
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

  it("labels every balanced-recall result with its trust verdict (narrative)", async () => {
    // Balanced recall injects sourced/unsourced memory BY DESIGN — but the
    // promise (README, SECURITY.md) is that it arrives LABELED. Every item
    // must carry the verdict the firewall already computed.
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "auth.ts"), "// bearer auth tokens, 1h TTL\n");
    // verified: file-backed, hash still matches
    await observe(root, "src/auth.ts", "auth uses bearer auth tokens with a 1h TTL");
    // sourced (unverified): command-only evidence, no files
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "s1",
        project: root,
        cwd: root,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "Bash",
          tool_input: { command: "true" },
          tool_output: "ops said bearer auth tokens rotate weekly",
        },
      },
    });
    // unsourced: a bare prompt, no evidence at all
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "prompt_submit",
        sessionId: "s1",
        project: root,
        cwd: root,
        timestamp: new Date().toISOString(),
        data: { prompt: "please investigate the bearer auth tokens setup" },
      },
    });

    const r = (await sdk.trigger({
      function_id: "mem::search",
      payload: {
        query: "bearer auth tokens",
        cwd: root,
        project: root,
        limit: 10,
        safe_only: true,
        format: "narrative",
      },
    })) as { results: Array<{ trust?: string }>; text: string };

    expect(r.results.length).toBe(3);
    for (const item of r.results) {
      expect(["verified", "sourced", "unsourced"]).toContain(item.trust);
    }
    // The packed narrative text — what actually gets injected — carries the
    // labels inline.
    expect(r.text).toContain("[verified]");
    expect(r.text).toContain("[sourced]");
    expect(r.text).toContain("[unsourced]");

    // Regression for #78: this mixed balanced result used to increment one
    // aggregate that status mislabeled entirely as "verified served".
    const stats = await summarizeFirewall(kv);
    expect(stats.injected).toBe(3);
    expect(stats.served).toEqual({
      verified: 1,
      cosmetic: 0,
      sourced: 1,
      unsourced: 1,
      legacyUnclassified: 0,
    });
  });

  it("labels compact-format balanced recall too", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "auth.ts"), "// bearer auth tokens\n");
    await observe(root, "src/auth.ts", "auth uses bearer auth tokens");
    const r = (await sdk.trigger({
      function_id: "mem::search",
      payload: {
        query: "bearer auth tokens",
        cwd: root,
        project: root,
        limit: 10,
        safe_only: true,
        format: "compact",
      },
    })) as { results: Array<{ trust?: string }> };
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.trust).toBe("verified");
  });

  it("counts only results that survive final token-budget packing", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    for (const name of ["one.ts", "two.ts"]) {
      writeFileSync(join(root, "src", name), `// quartz budget ${name}\n`);
      await observe(
        root,
        `src/${name}`,
        `quartz budget memory from ${name} with enough distinct detail`,
      );
    }

    // Measure the first compact item with an unguarded lookup. Legacy/plain
    // lookups classify results but intentionally do not affect firewall stats.
    const preview = (await sdk.trigger({
      function_id: "mem::search",
      payload: {
        query: "quartz budget memory",
        cwd: root,
        project: root,
        limit: 10,
        format: "compact",
      },
    })) as { results: Array<{ obsId: string; trust: string }> };
    expect(preview.results).toHaveLength(2);
    const oneItemBudget = Math.ceil(JSON.stringify(preview.results[0]).length / 3);

    const packed = (await sdk.trigger({
      function_id: "mem::search",
      payload: {
        query: "quartz budget memory",
        cwd: root,
        project: root,
        limit: 10,
        safe_only: true,
        format: "compact",
        token_budget: oneItemBudget,
      },
    })) as {
      results: Array<{ obsId: string; trust: string }>;
      truncated: boolean;
    };
    expect(packed.truncated).toBe(true);
    expect(packed.results).toHaveLength(1);

    const stats = await summarizeFirewall(kv);
    expect(stats.recalls).toBe(1);
    expect(stats.injected).toBe(1);
    expect(stats.served).toEqual({
      verified: 1,
      cosmetic: 0,
      sourced: 0,
      unsourced: 0,
      legacyUnclassified: 0,
    });
  });

  it("counts one returned memory once in each repeated recall event", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "repeat.ts"), "// topaz repeated recall\n");
    await observe(root, "src/repeat.ts", "topaz repeated recall memory");

    for (let event = 0; event < 2; event++) {
      const result = (await sdk.trigger({
        function_id: "mem::search",
        payload: {
          query: "topaz repeated recall",
          cwd: root,
          project: root,
          limit: 10,
          safe_only: true,
          format: "compact",
        },
      })) as { results: Array<{ obsId: string }> };
      expect(result.results).toHaveLength(1);
    }

    const stats = await summarizeFirewall(kv);
    expect(stats.recalls).toBe(2);
    expect(stats.injected).toBe(2);
    expect(stats.served.verified).toBe(2);
    expect(stats.served.legacyUnclassified).toBe(0);
  });

  it("plain (non-safe_only) search is still classified and labeled", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "auth.ts"), "// bearer auth tokens\n");
    await observe(root, "src/auth.ts", "auth uses bearer auth tokens");
    const r = (await sdk.trigger({
      function_id: "mem::search",
      payload: {
        query: "bearer auth tokens",
        cwd: root,
        project: root,
        limit: 10,
        format: "narrative",
      },
    })) as {
      results: Array<{ trust: string; source_status: string; evidence: string }>;
      text: string;
    };
    expect(r.results.length).toBe(1);
    expect(r.results[0]).toMatchObject({
      trust: "verified",
      source_status: "source-verified",
    });
    expect(r.results[0]!.evidence).toMatch(/match their captured hashes/);
    expect(r.text).toContain("[verified]");
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

describe("capped capture evidence never certifies verified (truncation)", () => {
  // The false-verified repro: a tool call referencing MORE files than the
  // capture cap. The uncaptured tail can drift undetected, so hashes over
  // the captured subset must cap the verdict at sourced_unverified.
  it("marks truncated captures mixedTrust and refuses to verify them", () => {
    const root = mkdtempSync(join(tmpdir(), "mw-trunc-"));
    try {
      const names: string[] = [];
      for (let i = 1; i <= 65; i++) {
        const f = `f${String(i).padStart(2, "0")}.ts`;
        writeFileSync(join(root, f), `export const x${i} = ${i};\n`);
        names.push(f);
      }
      const prov = extractProvenance({
        cwd: root,
        data: {
          tool_name: "Patch",
          tool_input: { changes: names.map((f) => ({ file_path: f })) },
        },
      });
      prov.fileHashes = hashFiles(prov.files, root);
      expect(prov.mixedTrust).toBe(true);

      // Drift ONLY the uncaptured file: must not come back verified.
      writeFileSync(join(root, "f65.ts"), "// drifted\n");
      expect(classifyProvenance(prov, root).status).toBe("sourced_unverified");

      // Drift a TRACKED file: staleness detection still works.
      writeFileSync(join(root, "f01.ts"), "// drifted too\n");
      expect(classifyProvenance(prov, root).status).toBe("stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mark small captures (no truncation) — they still verify", () => {
    const root = mkdtempSync(join(tmpdir(), "mw-notrunc-"));
    try {
      const names: string[] = [];
      for (let i = 1; i <= 10; i++) {
        const f = `s${i}.ts`;
        writeFileSync(join(root, f), `export const y = ${i};\n`);
        names.push(f);
      }
      const prov = extractProvenance({
        cwd: root,
        data: {
          tool_name: "Patch",
          tool_input: { changes: names.map((f) => ({ file_path: f })) },
        },
      });
      prov.fileHashes = hashFiles(prov.files, root);
      expect(prov.mixedTrust).toBeUndefined();
      expect(classifyProvenance(prov, root).status).toBe("verified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
