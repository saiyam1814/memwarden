import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FINE_GRAINED_EVIDENCE_FORMAT,
  MAX_ANCHOR_FILE_BYTES,
  MAX_ANCHOR_LINES,
  MAX_FINE_GRAINED_ANCHORS,
  captureFineGrainedEvidence,
  cloneFineGrainedEvidence,
  isFineGrainedEvidence,
  sourceCommitAt,
  verifyFineGrainedEvidence,
} from "../src/functions/anchors.js";
import {
  classifyProvenance,
  hashFiles,
  hashFilesNormalized,
} from "../src/functions/verify.js";
import { lifecycleProjection } from "../src/functions/memory-lifecycle.js";
import type {
  FineGrainedEvidence,
  Memory,
  Provenance,
} from "../src/functions/types.js";
import {
  parseCanon,
  reanchorRecord,
  recordFromMemory,
  serializeCanon,
  verifyCanon,
} from "../src/cli/canon.js";
import { importCanonRecord, isCanonRecord } from "../src/functions/canon.js";
import {
  BRAIN_BUNDLE_KIND,
  BRAIN_BUNDLE_VERSION,
  exportBundle,
  importBundle,
  isBrainBundle,
} from "../src/bundle/bundle.js";
import {
  __resetKernelSingleton,
  registerWorker,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  getSearchIndex,
  registerCoreFunctions,
} from "../src/functions/index.js";
import { gitProjectKey, __resetGitIdentityCache } from "../src/functions/git-identity.js";

const roots: string[] = [];
const kernels: Kernel[] = [];

function tempRoot(prefix = "memwarden-anchor-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function editEvidence(args: {
  root: string;
  path?: string;
  content: string;
  oldString?: string;
  newString?: string;
  output?: unknown;
  referencedFiles?: string[];
}): FineGrainedEvidence | undefined {
  const path = args.path ?? "src/policy.ts";
  write(args.root, path, args.content);
  return captureFineGrainedEvidence({
    hookType: "post_tool_use",
    toolName: "Edit",
    toolInput: {
      file_path: path,
      old_string: args.oldString ?? "export const TTL = 3600;",
      new_string: args.newString ?? "export const TTL = 900;",
    },
    toolOutput: args.output ?? "ok",
    cwd: args.root,
    referencedFiles: args.referencedFiles ?? [path],
    observationType: "file_edit",
  });
}

function provenance(
  root: string,
  path: string,
  anchors?: FineGrainedEvidence,
): Provenance {
  return {
    cwd: root,
    files: [path],
    fileHashes: hashFiles([path], root),
    fileHashesNormalized: hashFilesNormalized([path], root),
    ...(anchors ? { anchors } : {}),
  };
}

function activeMemory(prov: Provenance): Memory {
  return {
    id: "mem_anchor",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    type: "architecture",
    title: "TTL policy",
    content: "TTL is 900 seconds",
    concepts: ["ttl"],
    files: [...(prov.files ?? [])],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
    lifecycle: "active",
    lifecycleReason: "captured",
    provenance: prov,
  };
}

function freshKernel(name: string): { sdk: Kernel; kv: StateKV } {
  __resetKernelSingleton();
  getSearchIndex().clear();
  const sdk = registerWorker("in-process", { workerName: name }, {
    store: new StoreMemory(),
  });
  const kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  kernels.push(sdk);
  return { sdk, kv };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.shutdown().catch(() => undefined);
  __resetKernelSingleton();
  __resetGitIdentityCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fine-grained capture", () => {
  it("captures a unique live post-edit span as hash/location metadata only", () => {
    const root = tempRoot();
    const evidence = editEvidence({
      root,
      content: "// auth\nexport const TTL = 900;\nexport const MODE = 'strict';\n",
    });

    expect(evidence).toMatchObject({
      format: FINE_GRAINED_EVIDENCE_FORMAT,
      coverage: { claim: "complete", sources: "complete" },
      completeness: "complete",
      anchors: [
        {
          kind: "edit_span",
          path: "src/policy.ts",
          occurrence: { count: 1, capped: false, unique: true },
          contentCompleteness: "complete",
        },
      ],
    });
    expect(evidence!.anchors[0]!.rawHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence!.anchors[0]!.normalizedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain("export const TTL");
    expect(verifyFineGrainedEvidence(evidence, root).status).toBe("raw_match");
  });

  it("does not mint an anchor from a non-unique post-edit new_string", () => {
    const root = tempRoot();
    const evidence = editEvidence({
      root,
      content: "export const TTL = 900;\nexport const TTL = 900;\n",
    });
    expect(evidence).toBeUndefined();
  });

  it("keeps semantic tool output and command/test results non-revalidating", () => {
    const root = tempRoot();
    const partial = editEvidence({
      root,
      content: "export const TTL = 900;\n",
      output: "This proves every authentication token expires safely",
    });
    expect(partial).toMatchObject({
      coverage: { claim: "partial", sources: "complete" },
      completeness: "partial",
    });

    const command = captureFineGrainedEvidence({
      hookType: "post_tool_use",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolOutput: "all tests passed",
      cwd: root,
      observationType: "command_run",
    });
    expect(command).toBeUndefined();
  });

  it("captures an explicit valid read range and rejects invalid/oversized ranges", () => {
    const root = tempRoot();
    write(root, "src/read.ts", "first\nTARGET_POLICY\nthird\n");
    const evidence = captureFineGrainedEvidence({
      hookType: "post_tool_use",
      toolName: "Read",
      toolInput: { file_path: "src/read.ts", start_line: 2, end_line: 2 },
      toolOutput: "TARGET_POLICY",
      cwd: root,
      referencedFiles: ["src/read.ts"],
      observationType: "file_read",
    });
    expect(evidence).toMatchObject({
      completeness: "complete",
      anchors: [{ kind: "line_range", path: "src/read.ts" }],
    });
    const readProvenance = provenance(root, "src/read.ts", evidence);
    write(root, "src/read.ts", "inserted\nfirst\nTARGET_POLICY\nchanged third\n");
    expect(classifyProvenance(readProvenance, root)).toMatchObject({
      status: "verified",
      fineGrained: { status: "raw_match" },
    });
    write(root, "src/read.ts", "inserted\nfirst\nREPLACED_POLICY\nchanged third\n");
    expect(classifyProvenance(readProvenance, root)).toMatchObject({
      status: "stale",
      fineGrained: { status: "drifted" },
    });

    expect(
      captureFineGrainedEvidence({
        hookType: "post_tool_use",
        toolName: "Read",
        toolInput: { file_path: "src/read.ts", start_line: 2, end_line: 99 },
        toolOutput: "TARGET_POLICY",
        cwd: root,
        referencedFiles: ["src/read.ts"],
        observationType: "file_read",
      }),
    ).toBeUndefined();
    expect(
      captureFineGrainedEvidence({
        hookType: "post_tool_use",
        toolName: "Read",
        toolInput: {
          file_path: "src/read.ts",
          offset: 1,
          limit: MAX_ANCHOR_LINES + 1,
        },
        cwd: root,
        referencedFiles: ["src/read.ts"],
        observationType: "file_read",
      }),
    ).toBeUndefined();
  });

  it("narrowly captures an unambiguous top-level JSON key/value", () => {
    const root = tempRoot();
    write(
      root,
      "package.json",
      '{"feature":{"enabled":true,"mode":"strict"},"other":1}\n',
    );
    const evidence = captureFineGrainedEvidence({
      hookType: "post_tool_use",
      toolName: "ConfigEdit",
      toolInput: {
        file_path: "package.json",
        config_key: "feature",
        value: { enabled: true, mode: "strict" },
      },
      toolOutput: "ok",
      cwd: root,
      referencedFiles: ["package.json"],
      observationType: "file_edit",
    });
    expect(evidence).toMatchObject({
      completeness: "complete",
      anchors: [
        {
          kind: "json_config_value",
          normalization: "json-canonical-value-v1",
          location: { keyPath: ["feature"] },
        },
      ],
    });
    const configProvenance = provenance(root, "package.json", evidence);
    write(
      root,
      "package.json",
      '{\n  "other": 2,\n  "feature": { "mode": "strict", "enabled": true }\n}\n',
    );
    expect(classifyProvenance(configProvenance, root)).toMatchObject({
      status: "sourced_unverified",
      sourceStatus: "matched",
      fineGrained: { status: "cosmetic_match" },
    });
    write(
      root,
      "package.json",
      '{"feature":{"enabled":false,"mode":"strict"},"other":2}\n',
    );
    expect(classifyProvenance(configProvenance, root)).toMatchObject({
      status: "stale",
      fineGrained: { status: "drifted" },
    });

    write(root, "duplicate.json", '{"feature":1,"feature":1}\n');
    expect(
      captureFineGrainedEvidence({
        hookType: "post_tool_use",
        toolName: "ConfigEdit",
        toolInput: {
          file_path: "duplicate.json",
          config_key: "feature",
          value: 1,
        },
        toolOutput: "ok",
        cwd: root,
        referencedFiles: ["duplicate.json"],
        observationType: "file_edit",
      }),
    ).toBeUndefined();
  });
});

describe("bounded verification and lifecycle projection", () => {
  it("allows unrelated same-file edits and line shifts when the unique unit is unchanged", () => {
    const root = tempRoot();
    const path = "src/policy.ts";
    const evidence = editEvidence({
      root,
      path,
      content: "// heading\nexport const TTL = 900;\nexport const OTHER = 1;\n",
    })!;
    const prov = provenance(root, path, evidence);

    write(
      root,
      path,
      "// newly inserted line\n// heading\nexport const TTL = 900;\nexport const OTHER = 2;\n",
    );
    const verdict = classifyProvenance(prov, root);
    expect(verdict).toMatchObject({
      status: "verified",
      sourceStatus: "matched",
      fineGrained: { status: "raw_match", actionable: true },
    });
    expect(
      lifecycleProjection(activeMemory(prov), verdict.sourceStatus).effective,
    ).toBe("active");
  });

  it("catches edits inside the anchored unit and projects needs_revalidation", () => {
    const root = tempRoot();
    const path = "src/policy.ts";
    const evidence = editEvidence({
      root,
      path,
      content: "export const TTL = 900;\nexport const OTHER = 1;\n",
    })!;
    const prov = provenance(root, path, evidence);
    write(root, path, "export const TTL = 60;\nexport const OTHER = 1;\n");

    const verdict = classifyProvenance(prov, root);
    expect(verdict).toMatchObject({
      status: "stale",
      sourceStatus: "drifted",
      fineGrained: { status: "drifted", actionable: true },
    });
    expect(
      lifecycleProjection(activeMemory(prov), verdict.sourceStatus).effective,
    ).toBe("needs_revalidation");
  });

  it("distinguishes a cosmetic anchor match without blocking the active claim", () => {
    const root = tempRoot();
    const path = "src/policy.ts";
    const evidence = editEvidence({
      root,
      path,
      content: "header\nexport const TTL = 900;\nfooter\n",
    })!;
    const prov = provenance(root, path, evidence);
    write(root, path, "header changed\nexport const TTL = 900;   \nfooter\n");

    const verdict = classifyProvenance(prov, root);
    expect(verdict).toMatchObject({
      status: "sourced_unverified",
      sourceStatus: "matched",
      fineGrained: { status: "cosmetic_match", actionable: true },
    });
    expect(
      lifecycleProjection(activeMemory(prov), verdict.sourceStatus).effective,
    ).toBe("active");
  });

  it("distinguishes missing and newly ambiguous live anchors", () => {
    const root = tempRoot();
    const path = "src/policy.ts";
    const content = "export const TTL = 900;\nexport const OTHER = 1;\n";
    const evidence = editEvidence({ root, path, content })!;
    const prov = provenance(root, path, evidence);

    write(root, path, `${content}export const TTL = 900;\n`);
    expect(classifyProvenance(prov, root)).toMatchObject({
      status: "stale",
      fineGrained: { status: "ambiguous", actionable: true },
    });

    rmSync(join(root, path));
    expect(classifyProvenance(prov, root)).toMatchObject({
      status: "stale",
      sourceStatus: "missing",
      fineGrained: { status: "missing", actionable: true },
    });
  });

  it("treats incomplete coverage as advisory so whole-file drift still wins", () => {
    const root = tempRoot();
    const path = "src/policy.ts";
    const complete = editEvidence({
      root,
      path,
      content: "export const TTL = 900;\nexport const OTHER = 1;\n",
    })!;
    const incomplete: FineGrainedEvidence = {
      ...complete,
      coverage: { claim: "partial", sources: "complete" },
      completeness: "partial",
    };
    expect(isFineGrainedEvidence(incomplete)).toBe(true);
    const prov = provenance(root, path, incomplete);
    write(root, path, "export const TTL = 900;\nexport const OTHER = 2;\n");
    expect(classifyProvenance(prov, root)).toMatchObject({
      status: "stale",
      sourceStatus: "drifted",
      fineGrained: { status: "raw_match", actionable: false },
    });
  });

  it("preserves the legacy whole-file fallback when no anchors exist", () => {
    const root = tempRoot();
    const path = "src/legacy.ts";
    write(root, path, "export const LEGACY = 1;\n");
    const prov = provenance(root, path);
    expect(classifyProvenance(prov, root).status).toBe("verified");
    write(root, path, "export const LEGACY = 2;\n");
    const verdict = classifyProvenance(prov, root);
    expect(verdict.status).toBe("stale");
    expect(verdict.fineGrained).toBeUndefined();
  });

  it("rejects traversal and symlink escapes instead of hashing outside the checkout", () => {
    const root = tempRoot();
    const outside = tempRoot("memwarden-anchor-outside-");
    write(outside, "secret.ts", "export const SECRET = 1;\n");
    symlinkSync(join(outside, "secret.ts"), join(root, "escape.ts"));

    expect(
      captureFineGrainedEvidence({
        hookType: "post_tool_use",
        toolName: "Edit",
        toolInput: {
          file_path: "../outside.ts",
          old_string: "export const TTL = 3600;",
          new_string: "export const TTL = 900;",
        },
        toolOutput: "ok",
        cwd: root,
        referencedFiles: ["../outside.ts"],
        observationType: "file_edit",
      }),
    ).toBeUndefined();

    const sourceEvidence = editEvidence({
      root,
      path: "inside.ts",
      content: "export const TTL = 900;\n",
    })!;
    const escaped = cloneFineGrainedEvidence(sourceEvidence)!;
    escaped.anchors[0]!.path = "escape.ts";
    expect(isFineGrainedEvidence(escaped)).toBe(true);
    const prov: Provenance = {
      cwd: root,
      files: ["escape.ts"],
      fileHashes: { "escape.ts": escaped.anchors[0]!.rawHash },
      anchors: escaped,
    };
    expect(classifyProvenance(prov, root)).toMatchObject({
      status: "stale",
      sourceStatus: "drifted",
      fineGrained: { status: "ambiguous", actionable: true },
    });
  });

  it("fails closed on file/anchor caps and malformed records", () => {
    const root = tempRoot();
    const path = "large.ts";
    const evidence = editEvidence({
      root,
      path,
      content: "export const TTL = 900;\n",
    })!;
    const tooMany = {
      ...evidence,
      anchors: Array.from({ length: MAX_FINE_GRAINED_ANCHORS + 1 }, (_, i) => ({
        ...evidence.anchors[0]!,
        path: `src/f${i}.ts`,
      })),
    };
    expect(isFineGrainedEvidence(tooMany)).toBe(false);
    expect(
      isFineGrainedEvidence({
        ...evidence,
        anchors: [{ ...evidence.anchors[0]!, rawHash: "present-but-not-a-hash" }],
      }),
    ).toBe(false);

    const prov = provenance(root, path, evidence);
    write(root, path, "x".repeat(MAX_ANCHOR_FILE_BYTES + 1));
    expect(classifyProvenance(prov, root)).toMatchObject({
      status: "stale",
      fineGrained: { status: "ambiguous", actionable: true },
    });
  });
});

describe("worktree, Canon, Bundle, and observe integration", () => {
  it("re-roots portable anchors across a real linked worktree using stable identity", () => {
    const base = tempRoot("memwarden-anchor-worktree-");
    const main = join(base, "main");
    const worktree = join(base, "worktree");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "config", "user.email", "anchor@example.test");
    git(main, "config", "user.name", "Anchor Test");
    write(main, "src/policy.ts", "export const TTL = 900;\nexport const OTHER = 1;\n");
    git(main, "add", ".");
    git(main, "commit", "-qm", "initial");
    const expectedCommit = git(main, "rev-parse", "HEAD");

    const evidence = captureFineGrainedEvidence({
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput: {
        file_path: "src/policy.ts",
        old_string: "export const TTL = 3600;",
        new_string: "export const TTL = 900;",
      },
      toolOutput: "ok",
      cwd: main,
      referencedFiles: ["src/policy.ts"],
      observationType: "file_edit",
    })!;
    const prov = provenance(main, "src/policy.ts", evidence);
    expect(sourceCommitAt(main)).toBe(expectedCommit);
    expect(evidence.anchors[0]!.sourceCommit).toBe(expectedCommit);

    git(main, "worktree", "add", "-q", "-b", "anchor-worktree", worktree);
    __resetGitIdentityCache();
    expect(gitProjectKey(worktree)).toBe(gitProjectKey(main));
    write(
      worktree,
      "src/policy.ts",
      "// worktree-only line\nexport const TTL = 900;\nexport const OTHER = 2;\n",
    );
    expect(
      classifyProvenance(prov, worktree, { verifyAgainstRoot: true }),
    ).toMatchObject({
      status: "verified",
      fineGrained: { status: "raw_match" },
    });
    const worktreeCanon = recordFromMemory(
      {
        id: "mem_worktree_anchor",
        title: "Worktree TTL",
        content: "TTL remains 900",
        concepts: ["ttl"],
        type: "architecture",
        files: ["src/policy.ts"],
        projectPath: main,
        projectKey: gitProjectKey(main)!,
        captureCwd: main,
        provenance: prov,
      },
      worktree,
      "2026-01-01T00:00:00.000Z",
    );
    expect(worktreeCanon?.anchors).toEqual(evidence);
    expect(verifyCanon([worktreeCanon!], worktree)[0]).toMatchObject({
      verdict: "verified",
      anchorStatus: "raw_match",
    });

    write(worktree, "src/policy.ts", "export const TTL = 60;\n");
    expect(
      classifyProvenance(prov, worktree, { verifyAgainstRoot: true }),
    ).toMatchObject({
      status: "stale",
      fineGrained: { status: "drifted" },
    });
  });

  it("round-trips anchors through Canon and locally recomputes status on import", async () => {
    const root = tempRoot();
    const path = "src/policy.ts";
    const evidence = editEvidence({
      root,
      path,
      content: "export const TTL = 900;\nexport const OTHER = 1;\n",
    })!;
    const prov = provenance(root, path, evidence);
    const record = recordFromMemory(
      {
        id: "mem_canon_anchor",
        title: "TTL policy",
        content: "TTL is 900 seconds",
        concepts: ["ttl"],
        type: "architecture",
        files: [path],
        projectPath: root,
        captureCwd: root,
        provenance: prov,
      },
      root,
      "2026-01-01T00:00:00.000Z",
    )!;
    expect(record.anchors).toEqual(evidence);
    const parsed = parseCanon(serializeCanon([record])).records[0]!;
    expect(isCanonRecord(parsed)).toBe(true);
    expect(parsed.anchors).toEqual(evidence);

    write(root, path, "export const TTL = 900;\nexport const OTHER = 2;\n");
    expect(verifyCanon([parsed], root)[0]).toMatchObject({
      verdict: "verified",
      anchorStatus: "raw_match",
      drifted: [path],
    });

    const { kv } = freshKernel("canon-anchor-import");
    const asserted = {
      ...parsed,
      anchorStatus: "verified",
      anchors: { ...parsed.anchors!, status: "raw_match" },
    };
    const imported = await importCanonRecord(kv, { root, record: asserted });
    expect(imported).toMatchObject({ ok: true, verdict: "verified" });
    const stored = await kv.get<Memory>(KV.memories, parsed.id);
    expect(stored?.provenance?.anchors).toEqual(evidence);
    expect(JSON.stringify(stored?.provenance?.anchors)).not.toContain('"status"');

    write(root, path, "export const TTL = 900;   \nexport const OTHER = 2;\n");
    const cosmeticRecord = { ...parsed, id: "mem_canon_cosmetic" };
    expect(verifyCanon([cosmeticRecord], root)[0]).toMatchObject({
      verdict: "cosmetic",
      anchorStatus: "cosmetic_match",
      anchorActionable: true,
    });
    expect(
      await importCanonRecord(kv, { root, record: cosmeticRecord }),
    ).toMatchObject({ ok: true, verdict: "cosmetic" });
    const reanchored = reanchorRecord(
      cosmeticRecord,
      root,
      "reviewer",
      "2026-01-02T00:00:00.000Z",
    )!;
    expect(reanchored.anchors).toBeUndefined();
    expect(verifyCanon([reanchored], root)[0]!.verdict).toBe("verified");

    const tampered = {
      ...parsed,
      id: "mem_canon_tampered",
      anchors: {
        ...parsed.anchors!,
        status: "raw_match",
        anchors: parsed.anchors!.anchors.map((anchor) => ({
          ...anchor,
          rawHash: "0".repeat(64),
          normalizedHash: "0".repeat(64),
          status: "raw_match",
        })),
      },
    };
    expect(
      await importCanonRecord(kv, { root, record: tampered }),
    ).toMatchObject({ ok: false, code: "hash_mismatch" });
  });

  it("preserves valid anchors through Brain Bundle and rejects malformed imports", async () => {
    const root = tempRoot();
    const evidence = editEvidence({
      root,
      path: "src/policy.ts",
      content: "export const TTL = 900;\n",
    })!;
    const { kv } = freshKernel("bundle-anchor-source");
    const memory = activeMemory(provenance(root, "src/policy.ts", evidence));
    await kv.set(KV.memories, memory.id, memory);

    const bundle = await exportBundle(kv);
    expect(bundle.memories[0]!.provenance?.anchors).toEqual(evidence);
    expect(isBrainBundle(bundle)).toBe(true);

    const destination = freshKernel("bundle-anchor-destination");
    await importBundle(destination.kv, bundle);
    expect(
      (await destination.kv.get<Memory>(KV.memories, memory.id))?.provenance
        ?.anchors,
    ).toEqual(evidence);

    const malformed = {
      kind: BRAIN_BUNDLE_KIND,
      version: BRAIN_BUNDLE_VERSION,
      sessions: [],
      memories: [
        {
          ...memory,
          provenance: {
            ...memory.provenance,
            anchors: { ...evidence, completeness: "complete", anchors: [] },
          },
        },
      ],
      observations: {},
    };
    expect(isBrainBundle(malformed)).toBe(false);
    await expect(
      importBundle(destination.kv, malformed as never),
    ).rejects.toThrow(/malformed fine-grained anchor metadata/);
  });

  it("captures anchors on the real observe path without retaining secret source payloads", async () => {
    const root = tempRoot();
    const path = "src/secret.ts";
    const secret = `ghp_${"z".repeat(40)}`;
    const newString = `export const TOKEN = '${secret}';`;
    write(root, path, `${newString}\n`);
    const { sdk, kv } = freshKernel("observe-anchor");
    const result = await sdk.trigger<unknown, { observationId: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "anchor-session",
        project: root,
        cwd: root,
        timestamp: "2026-01-01T00:00:00.000Z",
        data: {
          tool_name: "Edit",
          tool_input: {
            file_path: path,
            old_string: "export const TOKEN = '';",
            new_string: newString,
          },
          tool_output: "ok",
        },
      },
    });
    const observation = await kv.get<{
      provenance?: Provenance;
      narrative?: string;
    }>(KV.observations("anchor-session"), result.observationId);
    expect(observation?.provenance?.anchors?.completeness).toBe("complete");
    expect(JSON.stringify(observation?.provenance?.anchors)).not.toContain(secret);
    expect(JSON.stringify(observation)).not.toContain(secret);
    expect(readFileSync(join(root, path), "utf8")).toContain(secret);

    const beforeRecall = JSON.stringify(observation);
    write(root, path, `${newString}\nexport const UNRELATED = 1;\n`);
    const recalled = await sdk.trigger<
      unknown,
      {
        results: Array<{
          fine_grained_anchor_status?: string;
          fine_grained_anchor_actionable?: boolean;
        }>;
      }
    >({
      function_id: "mem::search",
      payload: {
        query: "TOKEN secret",
        cwd: root,
        project: root,
        mode: "current",
        format: "compact",
      },
    });
    expect(recalled.results[0]).toMatchObject({
      fine_grained_anchor_status: "raw_match",
      fine_grained_anchor_actionable: true,
    });
    expect(
      JSON.stringify(
        await kv.get(KV.observations("anchor-session"), result.observationId),
      ),
    ).toBe(beforeRecall);
  });
});
