//
// Versioned, pinned result artifacts for the memory half-life study.
//
// Generate (never clones or modifies the source repositories):
//   npm run eval:halflife:artifact -- generate \
//     --out eval/results/<run-id> --run-id <run-id> \
//     --source-microdata /path/to/microdata.csv /full/repo/paths...
//
// Validate committed files and content hashes:
//   npm run eval:halflife:artifact -- validate eval/results/<run-id>/manifest.json
//
// Reproduce from existing FULL checkouts. This refuses moving/mismatched HEADs:
//   npm run eval:halflife:artifact -- reproduce \
//     eval/results/<run-id>/manifest.json --corpus-root /path/to/corpus
//

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HALFLIFE_MANIFEST_KIND,
  HALFLIFE_SCHEMA_VERSION,
  HALFLIFE_SUMMARY_KIND,
  validatePinnedRunManifest,
  validatePinnedRunSummary,
  type AnalysisSummary,
  type MicrodataArtifact,
  type PinnedRunManifest,
  type PinnedRunSummary,
} from "./memory-halflife-contract.js";
import {
  ACTIVITY_WINDOW_DAYS,
  MAX_FILES_PER_POINT,
  MIN_SAMPLE,
  NON_SOURCE_EXCLUSION_POLICY,
  SWEEP_EXCLUSION_POLICY,
  WINDOWS,
  analyzeRepo,
  renderCsv,
  type CsvRow,
  type RepoResult,
  type StudyArm,
} from "./memory-halflife.js";
import {
  QUANTILE_METHOD,
  sampleMedian,
  sampleQuantileR7,
} from "./memory-halflife-statistics.js";

const ANALYSES = [
  { id: "primary", role: "primary", includeI18n: false },
  { id: "include-i18n", role: "sensitivity", includeI18n: true },
] as const;

const NON_CLAIM =
  "Source drift is revalidation exposure. This study never observes a memory, recall, wrong answer, or semantic falsehood, so it is not a measured wrong-memory rate.";

interface AnalysisRun {
  definition: {
    id: string;
    role: "primary" | "sensitivity";
    includeI18n: boolean;
  };
  results: RepoResult[];
  rows: CsvRow[];
  csv: string;
}

interface GeneratedBytes {
  summary: string;
  report: string;
  microdata: Map<string, string>;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function describeFirstCsvDifference(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const compared = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < compared; index++) {
    if (expectedLines[index] !== actualLines[index]) {
      return (
        `first difference at line ${index + 1}: ` +
        `source=${JSON.stringify(expectedLines[index] ?? "<missing>")}, ` +
        `reproduced=${JSON.stringify(actualLines[index] ?? "<missing>")}`
      );
    }
  }
  return "no line-level difference found";
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function pct(value: number | null): string {
  return value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function assertCompleteResult(result: RepoResult, context: string): asserts result is RepoResult {
  if (result.skipped) {
    throw new Error(`${context}: ${result.repo} refused — ${result.skipped}`);
  }
  const days = new Set(result.points.map((point) => point.days));
  for (const window of WINDOWS) {
    if (!days.has(window)) {
      throw new Error(
        `${context}: ${result.repo} has no distinct capture for ${window} days; refusing to publish an incomplete window under that label`,
      );
    }
  }
  if (!/^https:\/\//.test(result.repoUrl)) {
    throw new Error(`${context}: ${result.repo} has no publishable HTTPS origin URL`);
  }
  if (!/^[0-9a-f]{40}$/.test(result.head)) {
    throw new Error(`${context}: ${result.repo} did not resolve to a full HEAD SHA`);
  }
}

function runInitialAnalysis(repoPaths: readonly string[]): AnalysisRun {
  const rows: CsvRow[] = [];
  const results = repoPaths.map((repoPath) => analyzeRepo(repoPath, { includeI18n: false, csvRows: rows }));
  for (const result of results) assertCompleteResult(result, "primary analysis");
  return { definition: ANALYSES[0], results, rows, csv: renderCsv(rows) };
}

interface CaptureMapRepository {
  name: string;
  checkout: string;
  head: string;
  captures: Array<{ days: number; sha?: string; asOf?: string }>;
}

function gitRead(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveCommit(repoPath: string, revision: string, label: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(revision)) {
    throw new Error(`${label} must be a hexadecimal Git commit id or unambiguous prefix`);
  }
  let resolved: string;
  try {
    resolved = gitRead(repoPath, ["rev-parse", "--verify", `${revision}^{commit}`]);
  } catch {
    throw new Error(`${label} ${revision} does not resolve uniquely in ${repoPath}`);
  }
  if (!/^[0-9a-f]{40}$/.test(resolved)) {
    throw new Error(`${label} ${revision} did not resolve to a full Git SHA`);
  }
  return resolved;
}

function readCaptureMap(captureMapPath: string): CaptureMapRepository[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolve(captureMapPath), "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read capture map ${captureMapPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as any).repositories)) {
    throw new Error("capture map must contain a repositories array");
  }
  return (value as any).repositories as CaptureMapRepository[];
}

function runAsOfAnalysis(repoPaths: readonly string[], captureAsOf: string): AnalysisRun {
  const asOf = Date.parse(captureAsOf);
  if (!Number.isFinite(asOf)) throw new Error("--capture-as-of must be an ISO-8601 timestamp");
  const rows: CsvRow[] = [];
  const results = repoPaths.map((repoPath) => {
    const headSha = gitRead(repoPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      throw new Error(`${basename(repoPath)} HEAD did not resolve to a full Git SHA`);
    }
    const url = gitRead(repoPath, ["remote", "get-url", "origin"]);
    const captures = WINDOWS.map((days) => {
      const before = new Date(asOf - days * 24 * 60 * 60 * 1000).toISOString();
      const sha = gitRead(repoPath, [
        "rev-list",
        "-1",
        "--first-parent",
        `--before=${before}`,
        headSha,
      ]);
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(`${basename(repoPath)} has no ${days}-day capture before ${before}`);
      }
      return { days, sha };
    });
    return analyzeRepo(repoPath, {
      includeI18n: false,
      captures,
      expectedRepository: { name: basename(resolve(repoPath)), url, headSha },
      csvRows: rows,
    });
  });
  for (const result of results) assertCompleteResult(result, "as-of primary analysis");
  return { definition: ANALYSES[0], results, rows, csv: renderCsv(rows) };
}

function runCaptureMapAnalysis(
  repoPaths: readonly string[],
  captureMapPath: string,
): AnalysisRun {
  const seeds = readCaptureMap(captureMapPath);
  const seedByCheckout = new Map(seeds.map((seed) => [seed.checkout, seed]));
  if (seedByCheckout.size !== seeds.length) throw new Error("capture map checkout names must be unique");
  const rows: CsvRow[] = [];
  const results = repoPaths.map((repoPath) => {
    const checkout = basename(resolve(repoPath));
    const seed = seedByCheckout.get(checkout);
    if (!seed || typeof seed.name !== "string" || typeof seed.head !== "string" || !Array.isArray(seed.captures)) {
      throw new Error(`capture map is missing a valid entry for ${checkout}`);
    }
    const capturesByDay = new Map<number, { sha?: string; asOf?: string }>();
    for (const capture of seed.captures) {
      const hasSha = typeof capture.sha === "string";
      const hasAsOf = typeof capture.asOf === "string";
      if (!Number.isInteger(capture.days) || hasSha === hasAsOf) {
        throw new Error(
          `capture map entry for ${checkout} must give exactly one of sha or asOf for each capture`,
        );
      }
      if (capturesByDay.has(capture.days)) {
        throw new Error(`capture map entry for ${checkout} repeats ${capture.days} days`);
      }
      capturesByDay.set(
        capture.days,
        hasSha ? { sha: capture.sha! } : { asOf: capture.asOf! },
      );
    }
    const captures = WINDOWS.map((days) => {
      const capture = capturesByDay.get(days);
      if (!capture) throw new Error(`capture map entry for ${checkout} is missing ${days} days`);
      if (capture.sha) {
        return {
          days,
          sha: resolveCommit(repoPath, capture.sha, `${checkout} ${days}-day capture`),
        };
      }
      const asOf = Date.parse(capture.asOf!);
      if (!Number.isFinite(asOf)) {
        throw new Error(`capture map entry for ${checkout} ${days}d has an invalid asOf timestamp`);
      }
      const before = new Date(asOf - days * 24 * 60 * 60 * 1000).toISOString();
      const sha = gitRead(repoPath, [
        "rev-list",
        "-1",
        "--first-parent",
        `--before=${before}`,
        "HEAD",
      ]);
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(`${checkout} has no ${days}-day capture before ${before}`);
      }
      return { days, sha };
    });
    const headSha = resolveCommit(repoPath, seed.head, `${checkout} HEAD`);
    const url = gitRead(repoPath, ["remote", "get-url", "origin"]);
    return analyzeRepo(repoPath, {
      includeI18n: false,
      captures,
      expectedRepository: { name: seed.name, url, headSha },
      csvRows: rows,
    });
  });
  for (const result of results) assertCompleteResult(result, "capture-map primary analysis");
  return { definition: ANALYSES[0], results, rows, csv: renderCsv(rows) };
}

function runPinnedAnalysis(
  manifest: PinnedRunManifest,
  corpusRoot: string,
  definition: PinnedRunManifest["parameters"]["analyses"][number],
): AnalysisRun {
  const rows: CsvRow[] = [];
  const results = manifest.repositories.map((repo) => {
    const repoPath = resolve(corpusRoot, repo.checkout);
    const rootRelative = relative(resolve(corpusRoot), repoPath);
    if (rootRelative.startsWith("..") || isAbsolute(rootRelative)) {
      throw new Error(`checkout for ${repo.name} escapes --corpus-root`);
    }
    return analyzeRepo(repoPath, {
      includeI18n: definition.includeI18n,
      captures: repo.captures,
      expectedRepository: {
        name: repo.name,
        url: repo.url,
        headSha: repo.headSha,
      },
      csvRows: rows,
    });
  });
  for (const result of results) assertCompleteResult(result, `${definition.id} reproduction`);
  return { definition, results, rows, csv: renderCsv(rows) };
}

function runPinnedFromPrimary(
  repoPaths: readonly string[],
  primary: AnalysisRun,
  definition: (typeof ANALYSES)[number],
): AnalysisRun {
  const rows: CsvRow[] = [];
  const results = primary.results.map((primaryRepo, index) => {
    const repoPath = repoPaths[index];
    if (!repoPath) throw new Error(`missing checkout path for ${primaryRepo.repo}`);
    return analyzeRepo(repoPath, {
      includeI18n: definition.includeI18n,
      captures: primaryRepo.points.map((point) => ({ days: point.days, sha: point.captureCommit })),
      expectedRepository: {
        name: primaryRepo.repo,
        url: primaryRepo.repoUrl,
        headSha: primaryRepo.head,
      },
      csvRows: rows,
    });
  });
  for (const result of results) assertCompleteResult(result, `${definition.id} analysis`);
  return { definition, results, rows, csv: renderCsv(rows) };
}

function aggregateArm(
  results: readonly RepoResult[],
  days: number,
  armName: StudyArm,
): AnalysisSummary["acrossRepositories"][number]["arms"]["touched"] {
  const includedRepositories: string[] = [];
  const excludedRepositories: Array<{
    name: string;
    sampleSize: number;
    reason: "underpowered";
  }> = [];
  const values: number[] = [];
  for (const result of results) {
    const point = result.points.find((candidate) => candidate.days === days);
    if (!point) continue;
    const arm = point[armName];
    if (arm.sampled < MIN_SAMPLE) {
      excludedRepositories.push({ name: result.repo, sampleSize: arm.sampled, reason: "underpowered" });
    } else {
      includedRepositories.push(result.repo);
      values.push(arm.substantiveRate);
    }
  }
  return {
    includedRepositories,
    excludedRepositories,
    median: values.length > 0 ? sampleMedian(values) : null,
    q1: values.length >= 4 ? sampleQuantileR7(values, 0.25) : null,
    q3: values.length >= 4 ? sampleQuantileR7(values, 0.75) : null,
  };
}

function buildSummary(runId: string, runs: readonly AnalysisRun[]): PinnedRunSummary {
  const repositoryCount = runs[0]?.results.length ?? 0;
  const analyses = runs.map((run) => ({
    id: run.definition.id,
    role: run.definition.role,
    includeI18n: run.definition.includeI18n,
    repositories: run.results.map((repo) => ({
      name: repo.repo,
      url: repo.repoUrl,
      headSha: repo.head,
      headDate: repo.headDate,
      points: repo.points.map((point) => ({
        days: point.days,
        captureCommit: point.captureCommit,
        captureDate: point.captureDate,
        arms: {
          touched: {
            ...point.touched,
            underpowered: point.touched.sampled < MIN_SAMPLE,
          },
          random: {
            ...point.random,
            underpowered: point.random.sampled < MIN_SAMPLE,
          },
        },
        exclusions: point.exclusions,
      })),
    })),
    acrossRepositories: WINDOWS.map((days) => ({
      days,
      repositoryCount,
      arms: {
        touched: aggregateArm(run.results, days, "touched"),
        random: aggregateArm(run.results, days, "random"),
      },
    })),
  }));

  return validatePinnedRunSummary({
    schemaVersion: HALFLIFE_SCHEMA_VERSION,
    kind: HALFLIFE_SUMMARY_KIND,
    runId,
    repositoryCount,
    quantileMethod: QUANTILE_METHOD,
    metric: {
      name: "substantive source drift exposure",
      unit: "sampled files",
      nonClaim: NON_CLAIM,
    },
    analyses,
  });
}

function sampleLabel(sampled: number, underpowered: boolean): string {
  return underpowered ? `${sampled} (excluded)` : String(sampled);
}

function renderAnalysisSection(analysis: AnalysisSummary): string[] {
  const lines: string[] = [];
  lines.push(
    `## ${analysis.role === "primary" ? "Primary analysis" : "Sensitivity analysis"}: \`${analysis.id}\``,
    "",
    analysis.includeI18n
      ? "Localized documentation is included in this sensitivity run."
      : "Localized documentation is excluded in the primary run.",
    "",
    "### Across repositories",
    "",
    "| Age | Recently touched median | Touched included/excluded | Random median | Random included/excluded |",
    "| ---: | ---: | --- | ---: | --- |",
  );
  for (const aggregate of analysis.acrossRepositories) {
    const touched = aggregate.arms.touched;
    const random = aggregate.arms.random;
    const included = (arm: typeof touched) =>
      `n=${arm.includedRepositories.length} repos` +
      (arm.excludedRepositories.length > 0
        ? `; excluded ${arm.excludedRepositories.map((repo) => `${repo.name} (n=${repo.sampleSize})`).join(", ")}`
        : "; excluded none");
    lines.push(
      `| ${aggregate.days}d | ${pct(touched.median)} | ${markdownCell(included(touched))} | ` +
        `${pct(random.median)} | ${markdownCell(included(random))} |`,
    );
  }

  lines.push(
    "",
    "Quartiles use R-7 linear interpolation. IQRs are available in `summary.json`; with an even number of repositories, the median is the arithmetic mean of the two middle rates.",
    "",
    "### Per-repository arms and exclusions",
    "",
    "| Repository | Age | Capture SHA | Touched n | Touched drift exposure | Random n | Random drift exposure | Candidate exclusions touched (i18n/non-source) | Candidate exclusions random (i18n/non-source) | Sweep exclusions touched/random (commits) |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const repo of analysis.repositories) {
    for (const point of repo.points) {
      const touched = point.arms.touched;
      const random = point.arms.random;
      const candidates = point.exclusions.candidates;
      const sweeps = point.exclusions.sweeps;
      lines.push(
        `| ${repo.name} | ${point.days}d | \`${point.captureCommit}\` | ` +
          `${sampleLabel(touched.sampled, touched.underpowered)} | ${pct(touched.substantiveRate)} | ` +
          `${sampleLabel(random.sampled, random.underpowered)} | ${pct(random.substantiveRate)} | ` +
          `${candidates.touched.i18n}/${candidates.touched.nonSource} | ` +
          `${candidates.random.i18n}/${candidates.random.nonSource} | ` +
          `${sweeps.touchedFiles}/${sweeps.randomFiles} (${sweeps.commits}) |`,
      );
    }
  }
  lines.push("");
  return lines;
}

function buildReport(manifest: PinnedRunManifest, summary: PinnedRunSummary): string {
  const primary = summary.analyses.find((analysis) => analysis.role === "primary");
  if (!primary) throw new Error("summary has no primary analysis");
  const headline = (days: number): string => {
    const aggregate = primary.acrossRepositories.find((candidate) => candidate.days === days);
    if (!aggregate) return `No ${days}-day estimate is available.`;
    const touched = aggregate.arms.touched;
    const random = aggregate.arms.random;
    return (
      `At ${days} days, the median substantive drift exposure among recently touched files is ` +
      `**${pct(touched.median)}** across n=${touched.includedRepositories.length} repositories; ` +
      `the paired random-file median is **${pct(random.median)}** across ` +
      `n=${random.includedRepositories.length} repositories.`
    );
  };

  const lines = [
    `# Pinned source-drift study: ${manifest.runId}`,
    "",
    `**Study size: n=${summary.repositoryCount} repositories. This is a four-repository descriptive result, not a population estimate.**`,
    "",
    `Generated from the pinned inputs on ${manifest.createdAt}.`,
    "",
    "## Result",
    "",
    headline(30),
    "",
    headline(180),
    "",
    "The recently-touched arm is intentionally paired with a uniform-random file arm. The gap describes attention/churn selection; publishing the touched arm alone would omit the control.",
    "",
    "## Non-claim",
    "",
    `**${summary.metric.nonClaim}** A changed file can leave a recorded fact true, and an unchanged file can be affected by changes elsewhere. The rates below measure files requiring re-examination, not false memories or agent error.`,
    "",
    "## Exact repository identities",
    "",
    "| Repository | URL | Pinned HEAD SHA |",
    "| --- | --- | --- |",
    ...manifest.repositories.map(
      (repo) => `| ${repo.name} | ${repo.url} | \`${repo.headSha}\` |`,
    ),
    "",
    ...summary.analyses.flatMap(renderAnalysisSection),
    "## Artifact content hashes",
    "",
    "| Artifact | Analysis | Storage | SHA-256 | Bytes / rows |",
    "| --- | --- | --- | --- | ---: |",
    `| ${manifest.artifacts.summary.path} | summary | committed | \`${manifest.artifacts.summary.sha256}\` | ${manifest.artifacts.summary.bytes} bytes |`,
    ...manifest.artifacts.microdata.map((artifact) => {
      const location = artifact.storage === "committed" ? artifact.path : artifact.url;
      return (
        `| ${location} | ${artifact.analysis} | ${artifact.storage} | \`${artifact.sha256}\` | ` +
        `${artifact.bytes} bytes / ${artifact.rowCount} rows |`
      );
    }),
    "",
    "## Reproduce",
    "",
    "The command verifies every origin URL, exact HEAD SHA, full-clone status, and pinned capture SHA before analysis. It never clones or modifies a source repository. A missing checkout, moving HEAD, changed microdata, or changed result exits non-zero instead of reusing the published percentages.",
    "",
    "```bash",
    manifest.reproduction.command,
    "```",
    "",
  ];
  return lines.join("\n");
}

function makeMicrodataRef(
  analysis: string,
  path: string,
  csv: string,
  rowCount: number,
): MicrodataArtifact {
  return {
    storage: "committed",
    analysis,
    path,
    sha256: sha256(csv),
    bytes: byteLength(csv),
    rowCount,
  };
}

function manifestObject(
  runId: string,
  createdAt: string,
  outputDirectory: string,
  primary: AnalysisRun,
  summaryText: string,
  microdata: readonly MicrodataArtifact[],
  reportHash: string,
  reportBytes: number,
): unknown {
  const relativeOutput = relative(process.cwd(), outputDirectory).split("\\").join("/");
  const manifestPath = `${relativeOutput}/manifest.json`;
  return {
    schemaVersion: HALFLIFE_SCHEMA_VERSION,
    kind: HALFLIFE_MANIFEST_KIND,
    runId,
    createdAt,
    parameters: {
      windows: [...WINDOWS],
      activityWindowDays: ACTIVITY_WINDOW_DAYS,
      maxFilesPerPoint: MAX_FILES_PER_POINT,
      minimumArmSample: MIN_SAMPLE,
      quantileMethod: QUANTILE_METHOD,
      analyses: ANALYSES.map((analysis) => ({ ...analysis })),
      exclusionPolicy: {
        nonSourcePaths: NON_SOURCE_EXCLUSION_POLICY,
        sweeps: SWEEP_EXCLUSION_POLICY,
      },
    },
    repositories: primary.results.map((repo) => ({
      name: repo.repo,
      url: repo.repoUrl,
      checkout: basename(resolve(repo.repo)),
      headSha: repo.head,
      captures: repo.points.map((point) => ({ days: point.days, sha: point.captureCommit })),
    })),
    artifacts: {
      summary: {
        storage: "committed",
        path: "summary.json",
        sha256: sha256(summaryText),
        bytes: byteLength(summaryText),
      },
      report: {
        storage: "committed",
        path: "REPORT.md",
        sha256: reportHash,
        bytes: reportBytes,
      },
      microdata,
    },
    reproduction: {
      command:
        `npm run eval:halflife:artifact -- reproduce ${manifestPath} ` +
        "--corpus-root /path/to/halflife-corpus",
      requiresFullClones: true,
    },
  };
}

function correctManifestCheckouts(
  manifestValue: any,
  repoPaths: readonly string[],
): void {
  for (const [index, repoPath] of repoPaths.entries()) {
    if (manifestValue.repositories[index]) {
      manifestValue.repositories[index].checkout = basename(resolve(repoPath));
    }
  }
}

function ensureNewOutputDirectory(outputDirectory: string): void {
  if (existsSync(outputDirectory)) {
    const entries = readdirSync(outputDirectory);
    if (entries.length > 0) {
      throw new Error(`output directory is not empty: ${outputDirectory}`);
    }
  } else {
    mkdirSync(outputDirectory, { recursive: true });
  }
}

export function generateArtifact(options: {
  outputDirectory: string;
  runId: string;
  createdAt: string;
  sourceMicrodata: string;
  captureMap?: string;
  captureAsOf?: string;
  repoPaths: string[];
}): PinnedRunManifest {
  if (options.repoPaths.length === 0) throw new Error("generate requires at least one repository path");
  const uniqueCheckouts = new Set(options.repoPaths.map((repoPath) => basename(resolve(repoPath))));
  if (uniqueCheckouts.size !== options.repoPaths.length) {
    throw new Error("repository checkout directory names must be unique");
  }

  if (options.captureMap && options.captureAsOf) {
    throw new Error("use only one of --capture-map or --capture-as-of");
  }
  const primary = options.captureMap
    ? runCaptureMapAnalysis(options.repoPaths, options.captureMap)
    : options.captureAsOf
      ? runAsOfAnalysis(options.repoPaths, options.captureAsOf)
      : runInitialAnalysis(options.repoPaths);
  const sensitivity = runPinnedFromPrimary(options.repoPaths, primary, ANALYSES[1]);
  const sourceCsv = readFileSync(resolve(options.sourceMicrodata), "utf8");
  const sourceAnalysis = sourceCsv === primary.csv
    ? "primary"
    : sourceCsv === sensitivity.csv
      ? "include-i18n"
      : null;
  if (!sourceAnalysis) {
    throw new Error(
      "supplied raw microdata matches neither pinned analysis; " +
        `source sha256=${sha256(sourceCsv)}, primary sha256=${sha256(primary.csv)}, ` +
        `include-i18n sha256=${sha256(sensitivity.csv)}; ` +
        `primary ${describeFirstCsvDifference(sourceCsv, primary.csv)}; ` +
        `include-i18n ${describeFirstCsvDifference(sourceCsv, sensitivity.csv)}. ` +
        "Refusing to publish summary values.",
    );
  }
  const primaryCsv = sourceAnalysis === "primary" ? sourceCsv : primary.csv;
  const sensitivityCsv = sourceAnalysis === "include-i18n" ? sourceCsv : sensitivity.csv;
  const runs = [primary, sensitivity];
  const summary = buildSummary(options.runId, runs);
  const summaryText = jsonText(summary);
  const primaryRef = makeMicrodataRef("primary", "microdata.csv", primaryCsv, primary.rows.length);
  const sensitivityRef = makeMicrodataRef(
    "include-i18n",
    "include-i18n-microdata.csv",
    sensitivityCsv,
    sensitivity.rows.length,
  );
  const microdata = [primaryRef, sensitivityRef];

  const outputDirectory = resolve(options.outputDirectory);
  const draftValue = manifestObject(
    options.runId,
    options.createdAt,
    outputDirectory,
    primary,
    summaryText,
    microdata,
    "0".repeat(64),
    0,
  ) as any;
  correctManifestCheckouts(draftValue, options.repoPaths);
  const draft = validatePinnedRunManifest(draftValue);
  const report = buildReport(draft, summary);
  const finalValue = manifestObject(
    options.runId,
    options.createdAt,
    outputDirectory,
    primary,
    summaryText,
    microdata,
    sha256(report),
    byteLength(report),
  ) as any;
  correctManifestCheckouts(finalValue, options.repoPaths);
  const manifest = validatePinnedRunManifest(finalValue);
  validatePinnedRunSummary(summary, manifest);

  ensureNewOutputDirectory(outputDirectory);
  writeFileSync(resolve(outputDirectory, "summary.json"), summaryText, "utf8");
  writeFileSync(resolve(outputDirectory, "microdata.csv"), primaryCsv, "utf8");
  writeFileSync(resolve(outputDirectory, "include-i18n-microdata.csv"), sensitivityCsv, "utf8");
  writeFileSync(resolve(outputDirectory, "REPORT.md"), report, "utf8");
  writeFileSync(resolve(outputDirectory, "manifest.json"), jsonText(manifest), "utf8");
  return manifest;
}

function readManifest(manifestPath: string): PinnedRunManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  } catch (error) {
    throw new Error(`cannot read manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validatePinnedRunManifest(parsed);
}

function verifyBytes(label: string, content: string | Buffer, expectedHash: string, expectedBytes: number): void {
  const actualHash = sha256(content);
  const actualBytes = Buffer.byteLength(content);
  if (actualHash !== expectedHash || actualBytes !== expectedBytes) {
    throw new Error(
      `${label} content mismatch — expected sha256=${expectedHash}, bytes=${expectedBytes}; ` +
        `found sha256=${actualHash}, bytes=${actualBytes}`,
    );
  }
}

export function validateArtifact(manifestPath: string): PinnedRunManifest {
  const absoluteManifest = resolve(manifestPath);
  const artifactDirectory = dirname(absoluteManifest);
  const manifest = readManifest(absoluteManifest);

  const summaryPath = resolve(artifactDirectory, manifest.artifacts.summary.path);
  const summaryText = readFileSync(summaryPath, "utf8");
  verifyBytes("summary", summaryText, manifest.artifacts.summary.sha256, manifest.artifacts.summary.bytes);
  let summaryValue: unknown;
  try {
    summaryValue = JSON.parse(summaryText);
  } catch (error) {
    throw new Error(`summary is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  validatePinnedRunSummary(summaryValue, manifest);

  const reportPath = resolve(artifactDirectory, manifest.artifacts.report.path);
  const report = readFileSync(reportPath);
  verifyBytes("report", report, manifest.artifacts.report.sha256, manifest.artifacts.report.bytes);

  for (const artifact of manifest.artifacts.microdata) {
    if (artifact.storage === "external") continue;
    const csv = readFileSync(resolve(artifactDirectory, artifact.path), "utf8");
    verifyBytes(
      `${artifact.analysis} microdata`,
      csv,
      artifact.sha256,
      artifact.bytes,
    );
    if (!csv.startsWith("repo,days,arm,fate,path\n")) {
      throw new Error(`${artifact.analysis} microdata has an unexpected header`);
    }
    const rows = csv.trimEnd().split("\n").length - 1;
    if (rows !== artifact.rowCount) {
      throw new Error(
        `${artifact.analysis} microdata row count mismatch — expected ${artifact.rowCount}, found ${rows}`,
      );
    }
  }
  return manifest;
}

function regeneratedBytes(manifest: PinnedRunManifest, corpusRoot: string): GeneratedBytes {
  const runs = manifest.parameters.analyses.map((definition) =>
    runPinnedAnalysis(manifest, corpusRoot, definition),
  );
  const summary = buildSummary(manifest.runId, runs);
  validatePinnedRunSummary(summary, manifest);
  const summaryText = jsonText(summary);
  const microdata = new Map(runs.map((run) => [run.definition.id, run.csv]));
  const report = buildReport(manifest, summary);
  return { summary: summaryText, report, microdata };
}

export function reproduceArtifact(
  manifestPath: string,
  corpusRoot: string,
  outputDirectory?: string,
): PinnedRunManifest {
  const manifest = readManifest(manifestPath);
  const generated = regeneratedBytes(manifest, resolve(corpusRoot));
  verifyBytes(
    "reproduced summary",
    generated.summary,
    manifest.artifacts.summary.sha256,
    manifest.artifacts.summary.bytes,
  );
  verifyBytes(
    "reproduced report",
    generated.report,
    manifest.artifacts.report.sha256,
    manifest.artifacts.report.bytes,
  );
  for (const artifact of manifest.artifacts.microdata) {
    const csv = generated.microdata.get(artifact.analysis);
    if (csv === undefined) throw new Error(`no regenerated microdata for ${artifact.analysis}`);
    verifyBytes(
      `reproduced ${artifact.analysis} microdata`,
      csv,
      artifact.sha256,
      artifact.bytes,
    );
    const rows = csv.trimEnd().split("\n").length - 1;
    if (rows !== artifact.rowCount) {
      throw new Error(`reproduced ${artifact.analysis} row count mismatch`);
    }
  }

  if (outputDirectory) {
    const output = resolve(outputDirectory);
    ensureNewOutputDirectory(output);
    writeFileSync(resolve(output, "summary.json"), generated.summary, "utf8");
    writeFileSync(resolve(output, "REPORT.md"), generated.report, "utf8");
    for (const artifact of manifest.artifacts.microdata) {
      const csv = generated.microdata.get(artifact.analysis)!;
      const filename = artifact.storage === "committed" ? artifact.path : `${artifact.analysis}-microdata.csv`;
      writeFileSync(resolve(output, filename), csv, "utf8");
    }
  }
  return manifest;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string>;
}

function parseArguments(args: string[], allowedOptions: readonly string[]): ParsedArguments {
  const allowed = new Set(allowedOptions);
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!allowed.has(argument)) throw new Error(`unknown option: ${argument}`);
    if (options.has(argument)) throw new Error(`duplicate option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options.set(argument, value);
    index++;
  }
  return { positionals, options };
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = parsed.options.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function usage(): string {
  return (
    "usage:\n" +
    "  npx tsx eval/memory-halflife-artifact.ts generate --out DIR --run-id ID --source-microdata CSV [--capture-map JSON | --capture-as-of ISO] [--created-at ISO] REPO...\n" +
    "  npx tsx eval/memory-halflife-artifact.ts validate MANIFEST\n" +
    "  npx tsx eval/memory-halflife-artifact.ts reproduce MANIFEST --corpus-root DIR [--out-dir DIR]\n\n" +
    "No command clones or modifies a source repository. Generate byte-compares the supplied raw CSV; reproduce refuses non-full clones, origin/HEAD mismatches, and unpinned capture commits."
  );
}

export function main(): void {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "generate") {
      const parsed = parseArguments(args, [
        "--out",
        "--run-id",
        "--source-microdata",
        "--capture-map",
        "--capture-as-of",
        "--created-at",
      ]);
      const createdAt = parsed.options.get("--created-at") ?? new Date().toISOString();
      const manifest = generateArtifact({
        outputDirectory: requiredOption(parsed, "--out"),
        runId: requiredOption(parsed, "--run-id"),
        sourceMicrodata: requiredOption(parsed, "--source-microdata"),
        createdAt,
        ...(parsed.options.has("--capture-map")
          ? { captureMap: parsed.options.get("--capture-map")! }
          : {}),
        ...(parsed.options.has("--capture-as-of")
          ? { captureAsOf: parsed.options.get("--capture-as-of")! }
          : {}),
        repoPaths: parsed.positionals,
      });
      console.log(
        `generated and contract-validated ${manifest.runId} (${manifest.repositories.length} repositories)`,
      );
      return;
    }
    if (command === "validate") {
      const parsed = parseArguments(args, []);
      if (parsed.positionals.length !== 1) throw new Error("validate requires one manifest path");
      const manifest = validateArtifact(parsed.positionals[0]!);
      console.log(`validated ${manifest.runId}: committed files and content hashes match`);
      for (const artifact of manifest.artifacts.microdata) {
        if (artifact.storage === "external") {
          console.log(
            `external ${artifact.analysis} microdata declared at ${artifact.url} (expected sha256=${artifact.sha256}; not downloaded)`,
          );
        }
      }
      return;
    }
    if (command === "reproduce") {
      const parsed = parseArguments(args, ["--corpus-root", "--out-dir"]);
      if (parsed.positionals.length !== 1) throw new Error("reproduce requires one manifest path");
      const manifest = reproduceArtifact(
        parsed.positionals[0]!,
        requiredOption(parsed, "--corpus-root"),
        parsed.options.get("--out-dir"),
      );
      console.log(
        `reproduced ${manifest.runId}: repository identities, both arms, sensitivity, and all content hashes match`,
      );
      return;
    }
    console.error(usage());
    process.exitCode = 1;
  } catch (error) {
    console.error(`half-life artifact error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
