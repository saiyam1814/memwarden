import { z } from "zod";
import { QUANTILE_METHOD } from "./memory-halflife-statistics.js";

export const HALFLIFE_MANIFEST_KIND = "memwarden-memory-halflife-manifest" as const;
export const HALFLIFE_SUMMARY_KIND = "memwarden-memory-halflife-summary" as const;
export const HALFLIFE_SCHEMA_VERSION = 1 as const;

const sha1 = z.string().regex(/^[0-9a-f]{40}$/, "must be a full lowercase 40-character Git SHA");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 digest");
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const rate = z.number().finite().min(0).max(1);
const analysisId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a stable lowercase analysis id");
const runId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a filesystem-safe run id");
const relativeArtifactPath = z.string().min(1).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "must be a normalized relative path without traversal",
);
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", {
  message: "must be an HTTPS URL",
});
const isoTimestamp = z.string().datetime({ offset: true });

const committedArtifactSchema = z.object({
  storage: z.literal("committed"),
  path: relativeArtifactPath,
  sha256,
  bytes: nonNegativeInteger,
});

const committedMicrodataSchema = committedArtifactSchema.extend({
  analysis: analysisId,
  rowCount: nonNegativeInteger,
});

const externalMicrodataSchema = z.object({
  storage: z.literal("external"),
  analysis: analysisId,
  url: httpsUrl,
  sha256,
  bytes: nonNegativeInteger,
  rowCount: nonNegativeInteger,
});

export const pinnedRunManifestSchema = z
  .object({
    schemaVersion: z.literal(HALFLIFE_SCHEMA_VERSION),
    kind: z.literal(HALFLIFE_MANIFEST_KIND),
    runId,
    createdAt: isoTimestamp,
    parameters: z.object({
      windows: z.array(positiveInteger).nonempty(),
      activityWindowDays: positiveInteger,
      maxFilesPerPoint: positiveInteger,
      minimumArmSample: positiveInteger,
      quantileMethod: z.literal(QUANTILE_METHOD),
      analyses: z
        .array(
          z.object({
            id: analysisId,
            role: z.enum(["primary", "sensitivity"]),
            includeI18n: z.boolean(),
          }),
        )
        .min(2),
      exclusionPolicy: z.object({
        nonSourcePaths: z.string().min(1),
        sweeps: z.string().min(1),
      }),
    }),
    repositories: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
          url: httpsUrl,
          checkout: relativeArtifactPath,
          headSha: sha1,
          captures: z
            .array(
              z.object({
                days: positiveInteger,
                sha: sha1,
              }),
            )
            .nonempty(),
        }),
      )
      .nonempty(),
    artifacts: z.object({
      summary: committedArtifactSchema,
      report: committedArtifactSchema,
      microdata: z
        .array(z.discriminatedUnion("storage", [committedMicrodataSchema, externalMicrodataSchema]))
        .nonempty(),
    }),
    reproduction: z.object({
      command: z.string().min(1),
      requiresFullClones: z.literal(true),
    }),
  })
  .superRefine((manifest, ctx) => {
    const windows = new Set(manifest.parameters.windows);
    if (windows.size !== manifest.parameters.windows.length) {
      ctx.addIssue({ code: "custom", path: ["parameters", "windows"], message: "must not contain duplicate windows" });
    }

    const analyses = new Map<string, (typeof manifest.parameters.analyses)[number]>();
    for (const [index, analysis] of manifest.parameters.analyses.entries()) {
      if (analyses.has(analysis.id)) {
        ctx.addIssue({ code: "custom", path: ["parameters", "analyses", index, "id"], message: "analysis ids must be unique" });
      }
      analyses.set(analysis.id, analysis);
    }
    const primary = manifest.parameters.analyses.filter((analysis) => analysis.role === "primary");
    if (primary.length !== 1 || primary[0]?.includeI18n !== false) {
      ctx.addIssue({
        code: "custom",
        path: ["parameters", "analyses"],
        message: "must define exactly one primary analysis with includeI18n=false",
      });
    }
    if (!manifest.parameters.analyses.some((analysis) => analysis.role === "sensitivity" && analysis.includeI18n)) {
      ctx.addIssue({
        code: "custom",
        path: ["parameters", "analyses"],
        message: "must define an includeI18n=true sensitivity analysis",
      });
    }

    const repoNames = new Set<string>();
    const repoUrls = new Set<string>();
    const checkouts = new Set<string>();
    for (const [repoIndex, repo] of manifest.repositories.entries()) {
      for (const [set, value, label] of [
        [repoNames, repo.name, "repository names"],
        [repoUrls, repo.url, "repository URLs"],
        [checkouts, repo.checkout, "repository checkouts"],
      ] as const) {
        if (set.has(value)) {
          ctx.addIssue({ code: "custom", path: ["repositories", repoIndex], message: `${label} must be unique` });
        }
        set.add(value);
      }
      const captureDays = new Set<number>();
      const captureShas = new Set<string>();
      for (const [captureIndex, capture] of repo.captures.entries()) {
        if (!windows.has(capture.days)) {
          ctx.addIssue({
            code: "custom",
            path: ["repositories", repoIndex, "captures", captureIndex, "days"],
            message: "capture day must be declared in parameters.windows",
          });
        }
        if (captureDays.has(capture.days)) {
          ctx.addIssue({
            code: "custom",
            path: ["repositories", repoIndex, "captures", captureIndex, "days"],
            message: "capture days must be unique per repository",
          });
        }
        if (captureShas.has(capture.sha)) {
          ctx.addIssue({
            code: "custom",
            path: ["repositories", repoIndex, "captures", captureIndex, "sha"],
            message: "capture SHAs must be distinct so windows are not duplicate measurements",
          });
        }
        captureDays.add(capture.days);
        captureShas.add(capture.sha);
      }
      for (const window of windows) {
        if (!captureDays.has(window)) {
          ctx.addIssue({
            code: "custom",
            path: ["repositories", repoIndex, "captures"],
            message: `missing pinned capture for ${window} days`,
          });
        }
      }
    }

    const microdataAnalyses = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.microdata.entries()) {
      if (!analyses.has(artifact.analysis)) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", "microdata", index, "analysis"],
          message: "must reference a declared analysis",
        });
      }
      if (microdataAnalyses.has(artifact.analysis)) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", "microdata", index, "analysis"],
          message: "must have exactly one microdata artifact per analysis",
        });
      }
      microdataAnalyses.add(artifact.analysis);
    }
    for (const id of analyses.keys()) {
      if (!microdataAnalyses.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", "microdata"],
          message: `missing microdata artifact for analysis ${id}`,
        });
      }
    }
  });

const fateCountsSchema = z.object({
  identical: nonNegativeInteger,
  reformatted: nonNegativeInteger,
  modified: nonNegativeInteger,
  renamed: nonNegativeInteger,
  deleted: nonNegativeInteger,
});

const armResultSchema = z
  .object({
    sampled: nonNegativeInteger,
    fates: fateCountsSchema,
    driftRate: rate,
    substantiveRate: rate,
    underpowered: z.boolean(),
  })
  .superRefine((arm, ctx) => {
    const total = Object.values(arm.fates).reduce((sum, count) => sum + count, 0);
    if (total !== arm.sampled) {
      ctx.addIssue({ code: "custom", path: ["fates"], message: "fate counts must sum to sampled" });
    }
    const denominator = arm.sampled || 1;
    const expectedDrift = (arm.sampled - arm.fates.identical) / denominator;
    const expectedSubstantive =
      (arm.fates.modified + arm.fates.renamed + arm.fates.deleted) / denominator;
    if (Math.abs(arm.driftRate - expectedDrift) > Number.EPSILON * 8) {
      ctx.addIssue({ code: "custom", path: ["driftRate"], message: "must equal the rate implied by fate counts" });
    }
    if (Math.abs(arm.substantiveRate - expectedSubstantive) > Number.EPSILON * 8) {
      ctx.addIssue({
        code: "custom",
        path: ["substantiveRate"],
        message: "must equal the substantive rate implied by fate counts",
      });
    }
  });

const resultPointSchema = z.object({
  days: positiveInteger,
  captureCommit: sha1,
  captureDate: z.string().date(),
  arms: z.object({
    touched: armResultSchema,
    random: armResultSchema,
  }),
  exclusions: z.object({
    candidates: z.object({
      touched: z.object({ i18n: nonNegativeInteger, nonSource: nonNegativeInteger }),
      random: z.object({ i18n: nonNegativeInteger, nonSource: nonNegativeInteger }),
    }),
    sweeps: z.object({
      commits: nonNegativeInteger,
      touchedFiles: nonNegativeInteger,
      randomFiles: nonNegativeInteger,
    }),
  }),
});

const aggregateArmSchema = z.object({
  includedRepositories: z.array(z.string()),
  excludedRepositories: z.array(
    z.object({
      name: z.string(),
      sampleSize: nonNegativeInteger,
      reason: z.literal("underpowered"),
    }),
  ),
  median: rate.nullable(),
  q1: rate.nullable(),
  q3: rate.nullable(),
});

const analysisSummarySchema = z.object({
  id: analysisId,
  role: z.enum(["primary", "sensitivity"]),
  includeI18n: z.boolean(),
  repositories: z.array(
    z.object({
      name: z.string(),
      url: httpsUrl,
      headSha: sha1,
      headDate: z.string().date(),
      points: z.array(resultPointSchema),
    }),
  ),
  acrossRepositories: z.array(
    z.object({
      days: positiveInteger,
      repositoryCount: nonNegativeInteger,
      arms: z.object({
        touched: aggregateArmSchema,
        random: aggregateArmSchema,
      }),
    }),
  ),
});

export const pinnedRunSummarySchema = z
  .object({
    schemaVersion: z.literal(HALFLIFE_SCHEMA_VERSION),
    kind: z.literal(HALFLIFE_SUMMARY_KIND),
    runId,
    repositoryCount: positiveInteger,
    quantileMethod: z.literal(QUANTILE_METHOD),
    metric: z.object({
      name: z.literal("substantive source drift exposure"),
      unit: z.literal("sampled files"),
      nonClaim: z.string().min(1),
    }),
    analyses: z.array(analysisSummarySchema).min(2),
  })
  .superRefine((summary, ctx) => {
    const ids = new Set<string>();
    for (const [index, analysis] of summary.analyses.entries()) {
      if (ids.has(analysis.id)) {
        ctx.addIssue({ code: "custom", path: ["analyses", index, "id"], message: "analysis ids must be unique" });
      }
      ids.add(analysis.id);
      if (analysis.repositories.length !== summary.repositoryCount) {
        ctx.addIssue({
          code: "custom",
          path: ["analyses", index, "repositories"],
          message: "must contain repositoryCount repositories",
        });
      }
    }
    if (!summary.analyses.some((analysis) => analysis.role === "primary" && !analysis.includeI18n)) {
      ctx.addIssue({ code: "custom", path: ["analyses"], message: "primary analysis is missing" });
    }
    if (!summary.analyses.some((analysis) => analysis.role === "sensitivity" && analysis.includeI18n)) {
      ctx.addIssue({ code: "custom", path: ["analyses"], message: "i18n sensitivity analysis is missing" });
    }
  });

export type PinnedRunManifest = z.infer<typeof pinnedRunManifestSchema>;
export type PinnedRunSummary = z.infer<typeof pinnedRunSummarySchema>;
export type AnalysisSummary = PinnedRunSummary["analyses"][number];
export type SummaryRepository = AnalysisSummary["repositories"][number];
export type SummaryPoint = SummaryRepository["points"][number];
export type SummaryArm = SummaryPoint["arms"]["touched"];
export type MicrodataArtifact = PinnedRunManifest["artifacts"]["microdata"][number];

export class ArtifactContractError extends Error {
  readonly issues: string[];

  constructor(label: string, issues: string[]) {
    super(`${label} is invalid:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ArtifactContractError";
    this.issues = issues;
  }
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
}

export function validatePinnedRunManifest(value: unknown): PinnedRunManifest {
  const result = pinnedRunManifestSchema.safeParse(value);
  if (!result.success) {
    throw new ArtifactContractError("half-life manifest", formatZodIssues(result.error));
  }
  return result.data;
}

export function validatePinnedRunSummary(
  value: unknown,
  manifest?: PinnedRunManifest,
): PinnedRunSummary {
  const result = pinnedRunSummarySchema.safeParse(value);
  if (!result.success) {
    throw new ArtifactContractError("half-life summary", formatZodIssues(result.error));
  }
  const summary = result.data;
  if (!manifest) return summary;

  const issues: string[] = [];
  if (summary.runId !== manifest.runId) issues.push("runId does not match manifest");
  if (summary.repositoryCount !== manifest.repositories.length) {
    issues.push("repositoryCount does not match manifest");
  }
  const manifestAnalyses = new Map(manifest.parameters.analyses.map((analysis) => [analysis.id, analysis]));
  const manifestRepos = new Map(manifest.repositories.map((repo) => [repo.name, repo]));
  for (const analysis of summary.analyses) {
    const expectedAnalysis = manifestAnalyses.get(analysis.id);
    if (!expectedAnalysis) {
      issues.push(`analysis ${analysis.id} is not declared in manifest`);
      continue;
    }
    if (analysis.role !== expectedAnalysis.role || analysis.includeI18n !== expectedAnalysis.includeI18n) {
      issues.push(`analysis ${analysis.id} settings do not match manifest`);
    }
    const seenRepos = new Set<string>();
    for (const repo of analysis.repositories) {
      seenRepos.add(repo.name);
      const expectedRepo = manifestRepos.get(repo.name);
      if (!expectedRepo) {
        issues.push(`analysis ${analysis.id} has undeclared repository ${repo.name}`);
        continue;
      }
      if (repo.url !== expectedRepo.url || repo.headSha !== expectedRepo.headSha) {
        issues.push(`analysis ${analysis.id} repository ${repo.name} identity does not match manifest`);
      }
      const captures = new Map(expectedRepo.captures.map((capture) => [capture.days, capture.sha]));
      for (const point of repo.points) {
        if (captures.get(point.days) !== point.captureCommit) {
          issues.push(
            `analysis ${analysis.id} repository ${repo.name} capture at ${point.days} days does not match manifest`,
          );
        }
        const minimum = manifest.parameters.minimumArmSample;
        if (point.arms.touched.underpowered !== (point.arms.touched.sampled < minimum)) {
          issues.push(`analysis ${analysis.id} repository ${repo.name} touched underpowered flag is inconsistent`);
        }
        if (point.arms.random.underpowered !== (point.arms.random.sampled < minimum)) {
          issues.push(`analysis ${analysis.id} repository ${repo.name} random underpowered flag is inconsistent`);
        }
      }
    }
    for (const repoName of manifestRepos.keys()) {
      if (!seenRepos.has(repoName)) issues.push(`analysis ${analysis.id} is missing repository ${repoName}`);
    }
  }
  for (const analysisIdValue of manifestAnalyses.keys()) {
    if (!summary.analyses.some((analysis) => analysis.id === analysisIdValue)) {
      issues.push(`summary is missing analysis ${analysisIdValue}`);
    }
  }
  if (issues.length > 0) throw new ArtifactContractError("half-life summary", issues);
  return summary;
}
