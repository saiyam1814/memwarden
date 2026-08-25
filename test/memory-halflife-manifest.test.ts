import { describe, expect, it } from "vitest";
import {
  ArtifactContractError,
  validatePinnedRunManifest,
  validatePinnedRunSummary,
  type PinnedRunManifest,
} from "../eval/memory-halflife-contract.js";
import { validateArtifact } from "../eval/memory-halflife-artifact.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);

function manifestFixture(): unknown {
  return {
    schemaVersion: 1,
    kind: "memwarden-memory-halflife-manifest",
    runId: "2026-08-24-test",
    createdAt: "2026-08-24T00:00:00.000Z",
    parameters: {
      windows: [30, 180],
      activityWindowDays: 14,
      maxFilesPerPoint: 400,
      minimumArmSample: 30,
      quantileMethod: "R7_LINEAR_INTERPOLATION",
      analyses: [
        { id: "primary", role: "primary", includeI18n: false },
        { id: "include-i18n", role: "sensitivity", includeI18n: true },
      ],
      exclusionPolicy: {
        nonSourcePaths: "generated-vendored-lockfiles-binaries-fixtures-v1",
        sweeps: "format-or-large-tree-rewrite-v1",
      },
    },
    repositories: [
      {
        name: "example",
        url: "https://github.com/example/repo.git",
        checkout: "example",
        headSha: SHA_A,
        captures: [
          { days: 30, sha: SHA_B },
          { days: 180, sha: SHA_A },
        ],
      },
    ],
    artifacts: {
      summary: { storage: "committed", path: "summary.json", sha256: HASH_A, bytes: 100 },
      report: { storage: "committed", path: "REPORT.md", sha256: HASH_B, bytes: 200 },
      microdata: [
        {
          storage: "committed",
          analysis: "primary",
          path: "microdata.csv",
          sha256: HASH_A,
          bytes: 300,
          rowCount: 60,
        },
        {
          storage: "external",
          analysis: "include-i18n",
          url: "https://github.com/example/repo/releases/download/run/include-i18n.csv",
          sha256: HASH_B,
          bytes: 400,
          rowCount: 70,
        },
      ],
    },
    reproduction: {
      command: "npm run eval:halflife:artifact -- reproduce manifest.json --corpus-root /path/to/corpus",
      requiresFullClones: true,
    },
  };
}

function summaryFixture(): unknown {
  const arm = {
    sampled: 30,
    fates: { identical: 20, reformatted: 1, modified: 7, renamed: 1, deleted: 1 },
    driftRate: 10 / 30,
    substantiveRate: 9 / 30,
    underpowered: false,
  };
  const point = (days: number, captureCommit: string) => ({
    days,
    captureCommit,
    captureDate: "2026-07-24",
    arms: { touched: structuredClone(arm), random: structuredClone(arm) },
    exclusions: {
      candidates: {
        touched: { i18n: 0, nonSource: 2 },
        random: { i18n: 3, nonSource: 4 },
      },
      sweeps: { commits: 1, touchedFiles: 2, randomFiles: 3 },
    },
  });
  const aggregate = {
    includedRepositories: ["example"],
    excludedRepositories: [],
    median: 0.3,
    q1: null,
    q3: null,
  };
  const analysis = (id: string, role: "primary" | "sensitivity", includeI18n: boolean) => ({
    id,
    role,
    includeI18n,
    repositories: [
      {
        name: "example",
        url: "https://github.com/example/repo.git",
        headSha: SHA_A,
        headDate: "2026-08-24",
        points: [point(30, SHA_B), point(180, SHA_A)],
      },
    ],
    acrossRepositories: [
      {
        days: 30,
        repositoryCount: 1,
        arms: { touched: structuredClone(aggregate), random: structuredClone(aggregate) },
      },
      {
        days: 180,
        repositoryCount: 1,
        arms: { touched: structuredClone(aggregate), random: structuredClone(aggregate) },
      },
    ],
  });
  return {
    schemaVersion: 1,
    kind: "memwarden-memory-halflife-summary",
    runId: "2026-08-24-test",
    repositoryCount: 1,
    quantileMethod: "R7_LINEAR_INTERPOLATION",
    metric: {
      name: "substantive source drift exposure",
      unit: "sampled files",
      nonClaim: "Source drift exposure is not a measured wrong-memory rate.",
    },
    analyses: [
      analysis("primary", "primary", false),
      analysis("include-i18n", "sensitivity", true),
    ],
  };
}

describe("pinned half-life artifact contract", () => {
  it("accepts exact repository/capture SHAs and committed or content-addressed external microdata", () => {
    const manifest = validatePinnedRunManifest(manifestFixture());
    expect(manifest.repositories[0]?.headSha).toHaveLength(40);
    expect(manifest.artifacts.microdata[1]).toMatchObject({
      storage: "external",
      sha256: HASH_B,
    });
  });

  it("rejects abbreviated SHAs and missing pinned windows", () => {
    const value = manifestFixture() as any;
    value.repositories[0].headSha = "abcdef123456";
    value.repositories[0].captures.pop();
    expect(() => validatePinnedRunManifest(value)).toThrow(ArtifactContractError);
    expect(() => validatePinnedRunManifest(value)).toThrow(/full lowercase 40-character Git SHA/);
    expect(() => validatePinnedRunManifest(value)).toThrow(/missing pinned capture for 180 days/);
  });

  it("requires external microdata to have an HTTPS location and exact content hash", () => {
    const value = manifestFixture() as any;
    value.artifacts.microdata[1].url = "file:///tmp/microdata.csv";
    delete value.artifacts.microdata[1].sha256;
    expect(() => validatePinnedRunManifest(value)).toThrow(/must be an HTTPS URL/);
    expect(() => validatePinnedRunManifest(value)).toThrow(/sha256/);
  });

  it("requires primary and i18n-sensitivity microdata artifacts", () => {
    const value = manifestFixture() as any;
    value.artifacts.microdata.pop();
    expect(() => validatePinnedRunManifest(value)).toThrow(/missing microdata artifact for analysis include-i18n/);
  });

  it("validates result identities, both arms, fate totals, and underpowered flags", () => {
    const manifest = validatePinnedRunManifest(manifestFixture());
    const summary = validatePinnedRunSummary(summaryFixture(), manifest);
    expect(summary.analyses).toHaveLength(2);
    expect(summary.analyses[0]?.repositories[0]?.points[0]?.arms).toHaveProperty("touched");
    expect(summary.analyses[0]?.repositories[0]?.points[0]?.arms).toHaveProperty("random");
  });

  it("rejects a result that omits the random control arm", () => {
    const manifest = validatePinnedRunManifest(manifestFixture());
    const summary = summaryFixture() as any;
    delete summary.analyses[0].repositories[0].points[0].arms.random;
    expect(() => validatePinnedRunSummary(summary, manifest)).toThrow(/random/);
  });

  it("rejects a result whose capture identity does not match the manifest", () => {
    const manifest = validatePinnedRunManifest(manifestFixture()) as PinnedRunManifest;
    const summary = summaryFixture() as any;
    summary.analyses[1].repositories[0].points[0].captureCommit = SHA_A;
    expect(() => validatePinnedRunSummary(summary, manifest)).toThrow(/capture at 30 days does not match/);
  });

  it("validates the committed four-repository result and every content hash", () => {
    const manifest = validateArtifact(
      "eval/results/2026-08-24-four-repo/manifest.json",
    );
    expect(manifest.repositories).toHaveLength(4);
    expect(manifest.artifacts.microdata).toHaveLength(2);
  });
});
