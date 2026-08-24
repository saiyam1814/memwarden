//
// Memory half-life: how fast does a fact about source code stop being true?
//
// WHAT THIS MEASURES, AND WHY THIS SHAPE
//
// Every agent memory tool stores facts about code. None of the popular ones
// (claude-mem, Mem0, agentmemory, Hindsight) check whether the code a stored
// fact describes has since changed — Hindsight's own docs say "Nothing in the
// pipeline knows the world changed, so you tell it explicitly." So the obvious
// study would be "generate a competitor's store and grade it", and that study
// is worthless: it invites "you faked our data" and it deserves to.
//
// Instead this measures the PHYSICAL property underneath, which affects every
// memory tool identically and requires nothing but git: if you record a fact
// about a file today, how long until that file's content is no longer what you
// recorded? Real repos, real history, no simulation, one command to reproduce.
//
// METHOD
//   1. Pick a capture point T (a commit N days before HEAD).
//   2. Take the files a coding agent plausibly recorded facts about at T:
//      files touched in the ACTIVITY_WINDOW before T, minus generated/vendored
//      paths an agent has no business remembering.
//   3. Ask git what happened to each of those files between T and HEAD.
//   4. Classify: identical / reformatted-only / modified / renamed / deleted.
//
// A single `git diff --name-status -M T HEAD` answers step 3 for every file at
// once; content is read only for modified files, to split real change from
// reformatting (LF + trailing-whitespace normalization).
//
// NON-CLAIMS — print these with any published number:
//   - A changed hash does NOT prove the memory became false. A typo fix in a
//     comment changes the hash and invalidates nothing. This OVER-counts.
//   - An unchanged hash does NOT prove the memory stayed true. A file can be
//     untouched while a caller changes the behavior the memory described. This
//     UNDER-counts, and nothing here can measure it.
//   - So this is a measure of DRIFT EXPOSURE — how much stored memory a tool
//     would have to re-examine — not of semantic wrongness. It is the ceiling
//     on what source-verification can catch, not a count of actual lies.
//   - Rates are not comparable across repos with different release cadence,
//     squash-vs-merge history, or monorepo layout. Per-repo numbers only.
//
// WHAT THIS IS NOT
//
// It measures git history. It never observes a memory, a recall, an agent, or a
// wrong answer, so it cannot support "unchecked memory makes agents wrong" —
// only "the substrate memories point at turns over fast". The study that can
// support the causal claim is a prospective replay (real sessions at T, real
// memories harvested, fast-forward to HEAD, grade patches under
// no-memory / unchecked / blocked / annotate-only). This is the cheap mechanism
// layer underneath that, and every number here must be worded accordingly.
//
// TWO ARMS, on purpose. "Files touched near T" selects on the same latent churn
// rate that predicts the outcome, so that arm alone is not an unbiased estimate
// of anything. A uniform-random arm over files that existed at T is measured
// alongside it, and THE GAP BETWEEN THE ARMS IS THE FINDING: it quantifies how
// much of the drift rate is attention bias rather than repo-wide turnover.
//
// Run:  npx tsx eval/memory-halflife.ts <repo-path> [more-repo-paths...]
//       npx tsx eval/memory-halflife.ts --json <repo-path>
//       npx tsx eval/memory-halflife.ts --csv out.csv <repo-path>   (microdata)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Capture points, in days before HEAD. */
const WINDOWS = [7, 30, 90, 180, 365];

/** How far back from a capture point counts as "recent activity an agent saw". */
const ACTIVITY_WINDOW_DAYS = 14;

/** Cap per capture point so one enormous repo cannot dominate runtime. */
const MAX_FILES_PER_POINT = 400;

// Paths an agent has no business storing facts about. Including them would
// inflate every number: lockfiles and generated code change constantly and
// carry no decisions.
const EXCLUDE_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$/,
  /(^|\/)(node_modules|vendor|third_party|dist|build|out|target|\.next|coverage)\//,
  /(^|\/)(CHANGELOG|CHANGELOG\.md)$/i,
  /\.(min\.js|min\.css|map|snap|lock)$/,
  /(^|\/)(__snapshots__|testdata|fixtures)\//,
  /\.(png|jpe?g|gif|svg|ico|pdf|zip|tar|gz|woff2?|ttf|eot|mp4|wasm)$/i,
  /(^|\/)(go\.mod)$/,
  /(^|\/)\.git/,
];

function excluded(path: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(path));
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOk(repo: string, args: string[]): string | null {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

/** LF-normalized, trailing-whitespace-stripped hash: lets us separate a
 *  reformat from a real change instead of calling both "stale". */
function hashes(content: string): { raw: string; norm: string } {
  const raw = createHash("sha256").update(content).digest("hex");
  const normalized = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "\n");
  return {
    raw,
    norm: createHash("sha256").update(normalized).digest("hex"),
  };
}

type Fate = "identical" | "reformatted" | "modified" | "renamed" | "deleted";

interface ArmResult {
  sampled: number;
  fates: Record<Fate, number>;
  /** Share of sampled files whose recorded path or content no longer matches. */
  driftRate: number;
  /** Share whose CONTENT genuinely changed (excludes reformat-only). */
  substantiveRate: number;
}

interface PointResult {
  days: number;
  captureCommit: string;
  captureDate: string;
  /** Files an agent plausibly had facts about (touched near T). Selects on the
   *  same churn that predicts the outcome — read it against `random`. */
  touched: ArmResult;
  /** Uniform-random files existing at T: repo-wide turnover, no attention bias. */
  random: ArmResult;
  /** Files dropped because a formatter/license sweep rewrote them. */
  sweepExcluded: number;
  sweepCommits: number;
}

interface RepoResult {
  repo: string;
  head: string;
  headDate: string;
  points: PointResult[];
  skipped?: string;
}

/**
 * A capture point must sit on the default branch's first-parent chain.
 * Without --first-parent, `rev-list` can land mid-feature-branch, and "the
 * state of the world at T" is then a tree that never existed on main.
 */
function commitBeforeDays(repo: string, days: number): string | null {
  const out = gitOk(repo, [
    "rev-list",
    "-1",
    "--first-parent",
    `--before=${days} days ago`,
    "HEAD",
  ]);
  const sha = out?.trim();
  return sha && sha.length >= 7 ? sha : null;
}

/**
 * Commits that rewrote a large share of the tree in one go — formatter sweeps,
 * license-header and copyright-year bumps, import reordering. One of these
 * inside a window makes a repo's drift rate explode for reasons that have
 * nothing to do with knowledge going stale, so the files they touched are
 * excluded and the exclusion is REPORTED rather than silently applied.
 */
const FORMAT_COMMIT_MSG =
  /\b(prettier|gofmt|black|isort|rustfmt|clang-format|eslint --fix|reformat|re-format|formatting|whitespace|copyright year|license header|bump year)\b/i;

interface SweepInfo {
  /** Files excluded because a sweep touched them. */
  excludedFiles: Set<string>;
  sweepCommits: number;
}

function detectSweeps(repo: string, sha: string): SweepInfo {
  const excludedFiles = new Set<string>();
  let sweepCommits = 0;
  // Tracked-file count at HEAD is a good enough denominator for "large share".
  const treeCount = (gitOk(repo, ["ls-tree", "-r", "--name-only", "HEAD"]) ?? "")
    .split("\n")
    .filter(Boolean).length;
  if (treeCount === 0) return { excludedFiles, sweepCommits };
  const threshold = Math.max(25, Math.floor(treeCount * 0.1));

  // One pass over the window's commits with their touched files.
  const out = gitOk(repo, [
    "log",
    "--first-parent",
    "--no-merges",
    "--name-only",
    "--pretty=format:%x00%H%x1f%s",
    `${sha}..HEAD`,
  ]);
  if (!out) return { excludedFiles, sweepCommits };
  for (const chunk of out.split("\u0000")) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf("\n");
    const header = nl === -1 ? chunk : chunk.slice(0, nl);
    const subject = header.split("\u001f")[1] ?? "";
    const files = (nl === -1 ? "" : chunk.slice(nl + 1))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const isSweep = files.length >= threshold || FORMAT_COMMIT_MSG.test(subject);
    if (!isSweep) continue;
    sweepCommits++;
    for (const f of files) excludedFiles.add(f);
  }
  return { excludedFiles, sweepCommits };
}

/** Deterministic PRNG so a published run is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform-random sample of files that existed at T — the control arm. */
function randomFilesAt(repo: string, sha: string, seed: number): string[] {
  const all = (gitOk(repo, ["ls-tree", "-r", "--name-only", sha]) ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((p) => p && !excluded(p));
  const rnd = mulberry32(seed);
  // Fisher-Yates prefix: unbiased sample without shuffling the whole list.
  const n = Math.min(MAX_FILES_PER_POINT, all.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (all.length - i));
    const tmp = all[i]!;
    all[i] = all[j]!;
    all[j] = tmp;
  }
  return all.slice(0, n);
}

function commitDate(repo: string, sha: string): string {
  return (gitOk(repo, ["show", "-s", "--format=%cI", sha]) ?? "").trim();
}

/** Files touched in the activity window ending at `sha` — the proxy for "what
 *  an agent working in this repo at that time would have facts about".
 *
 *  The window must be relative to T's OWN date, not to now: `--since=14 days
 *  ago` on a commit from six months back selects nothing, which silently
 *  produced zero samples for every window. */
function activeFilesAt(repo: string, sha: string): string[] {
  const iso = commitDate(repo, sha);
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return [];
  const from = new Date(at - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const out = gitOk(repo, [
    "log",
    `--since=${from}`,
    `--until=${iso}`,
    "--name-only",
    "--pretty=format:",
    sha,
  ]);
  if (!out) return [];
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const p = line.trim();
    if (!p || excluded(p)) continue;
    seen.add(p);
    if (seen.size >= MAX_FILES_PER_POINT * 3) break;
  }
  // Keep only files that actually existed at T (a rename in the window can
  // list a path that is not present in that tree).
  const present: string[] = [];
  for (const p of seen) {
    if (gitOk(repo, ["cat-file", "-e", `${sha}:${p}`]) !== null) present.push(p);
    if (present.length >= MAX_FILES_PER_POINT) break;
  }
  return present;
}

/** old-path -> status for everything that changed between T and HEAD. One call. */
function changeMap(repo: string, sha: string): Map<string, "M" | "D" | "R"> {
  const map = new Map<string, "M" | "D" | "R">();
  // -M enables rename detection so a moved file is not miscounted as deleted.
  const out = gitOk(repo, ["diff", "--name-status", "-M", sha, "HEAD"]);
  if (!out) return map;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    if (code.startsWith("R")) {
      // R<score>\told\tnew
      const old = parts[1];
      if (old) map.set(old, "R");
    } else if (code.startsWith("D")) {
      const p = parts[1];
      if (p) map.set(p, "D");
    } else if (code.startsWith("M") || code.startsWith("T")) {
      const p = parts[1];
      if (p) map.set(p, "M");
    }
    // 'A' (added after T) cannot be in our sample; ignore.
  }
  return map;
}

function blob(repo: string, ref: string, path: string): string | null {
  return gitOk(repo, ["cat-file", "blob", `${ref}:${path}`]);
}

type CsvRow = {
  repo: string;
  days: number;
  arm: "touched" | "random";
  path: string;
  fate: Fate;
};

const csvRows: CsvRow[] = [];

/** Classify one sampled file's fate between T and HEAD. */
function fateOf(
  repo: string,
  sha: string,
  path: string,
  changed: Map<string, "M" | "D" | "R">,
): Fate {
  const status = changed.get(path);
  if (!status) return "identical";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  const before = blob(repo, sha, path);
  const after = blob(repo, "HEAD", path);
  if (before === null || after === null) return "modified";
  const b = hashes(before);
  const a = hashes(after);
  if (b.raw === a.raw) return "identical";
  if (b.norm === a.norm) return "reformatted";
  return "modified";
}

function runArm(
  repo: string,
  repoName: string,
  days: number,
  arm: "touched" | "random",
  sha: string,
  files: string[],
  changed: Map<string, "M" | "D" | "R">,
): ArmResult {
  const fates: Record<Fate, number> = {
    identical: 0,
    reformatted: 0,
    modified: 0,
    renamed: 0,
    deleted: 0,
  };
  for (const path of files) {
    const fate = fateOf(repo, sha, path, changed);
    fates[fate]++;
    csvRows.push({ repo: repoName, days, arm, path, fate });
  }
  const sampled = files.length || 1;
  const drifted = files.length - fates.identical;
  const substantive = fates.modified + fates.renamed + fates.deleted;
  return {
    sampled: files.length,
    fates,
    driftRate: drifted / sampled,
    substantiveRate: substantive / sampled,
  };
}

function analyzePoint(
  repo: string,
  repoName: string,
  days: number,
): PointResult | null {
  const sha = commitBeforeDays(repo, days);
  if (!sha) return null;

  // Formatter/license sweeps are excluded from BOTH arms and reported, so one
  // Prettier run cannot masquerade as knowledge going stale.
  const sweep = detectSweeps(repo, sha);
  const keep = (p: string): boolean => !sweep.excludedFiles.has(p);

  const touchedAll = activeFilesAt(repo, sha);
  const touched = touchedAll.filter(keep);
  // Seed from the capture commit so a rerun samples identically.
  const seed = parseInt(sha.slice(0, 8), 16);
  const randomAll = randomFilesAt(repo, sha, seed);
  const random = randomAll.filter(keep);
  if (touched.length === 0 && random.length === 0) return null;

  const changed = changeMap(repo, sha);
  return {
    days,
    captureCommit: sha.slice(0, 12),
    captureDate: commitDate(repo, sha).slice(0, 10),
    touched: runArm(repo, repoName, days, "touched", sha, touched, changed),
    random: runArm(repo, repoName, days, "random", sha, random, changed),
    sweepExcluded:
      touchedAll.length - touched.length + (randomAll.length - random.length),
    sweepCommits: sweep.sweepCommits,
  };
}

function analyzeRepo(repoPath: string): RepoResult {
  const repo = resolve(repoPath);
  const name = basename(repo);
  if (!existsSync(repo)) {
    return { repo: name, head: "", headDate: "", points: [], skipped: "path does not exist" };
  }
  if (gitOk(repo, ["rev-parse", "--git-dir"]) === null) {
    return { repo: name, head: "", headDate: "", points: [], skipped: "not a git repository" };
  }
  const head = (gitOk(repo, ["rev-parse", "HEAD"]) ?? "").trim().slice(0, 12);
  const headDate = commitDate(repo, "HEAD").slice(0, 10);
  // A shallow clone silently truncates history and would fabricate low drift
  // for old windows. Refuse rather than under-report.
  const shallow = gitOk(repo, ["rev-parse", "--is-shallow-repository"])?.trim();
  if (shallow === "true") {
    return {
      repo: name,
      head,
      headDate,
      points: [],
      skipped: "shallow clone — history is truncated, so old windows would under-report drift. Re-clone without --depth.",
    };
  }

  // A sparse history makes several windows resolve to the SAME commit, which
  // would print the same measurement under different ages and read as
  // corroboration. Keep the first window that reaches each capture commit and
  // drop the duplicates.
  const points: PointResult[] = [];
  const seenCommits = new Set<string>();
  for (const days of WINDOWS) {
    const r = analyzePoint(repo, name, days);
    if (!r) continue;
    if (seenCommits.has(r.captureCommit)) continue;
    seenCommits.add(r.captureCommit);
    points.push(r);
  }
  return { repo: name, head, headDate, points };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function render(results: RepoResult[]): void {
  console.log(
    `\n  memory half-life — how fast the code a stored fact points at stops matching\n`,
  );
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.repo}: skipped — ${r.skipped}\n`);
      continue;
    }
    console.log(`  ${r.repo}  @ ${r.head} (${r.headDate})`);
    console.log(
      `    age    arm       n   identical  reformat  modified  renamed  deleted   changed`,
    );
    for (const p of r.points) {
      for (const [label, arm] of [
        ["touched", p.touched],
        ["random ", p.random],
      ] as const) {
        if (arm.sampled === 0) continue;
        const f = arm.fates;
        console.log(
          `    ${String(p.days).padStart(3)}d  ${label}  ` +
            `${String(arm.sampled).padStart(5)}   ` +
            `${String(f.identical).padStart(9)}  ` +
            `${String(f.reformatted).padStart(8)}  ` +
            `${String(f.modified).padStart(8)}  ` +
            `${String(f.renamed).padStart(7)}  ` +
            `${String(f.deleted).padStart(7)}   ` +
            `${pct(arm.substantiveRate).padStart(7)}`,
        );
      }
      // The gap IS the finding: how much of the rate is attention bias rather
      // than repo-wide turnover.
      if (p.touched.sampled > 0 && p.random.sampled > 0) {
        const gap = p.touched.substantiveRate - p.random.substantiveRate;
        console.log(
          `          gap ${gap >= 0 ? "+" : ""}${pct(gap)} (recently-touched vs repo-wide)` +
            (p.sweepCommits > 0
              ? `  ·  excluded ${p.sweepExcluded} files from ${p.sweepCommits} sweep commit(s)`
              : ""),
        );
      }
    }
    console.log("");
  }

  const withPoints = results.filter((r) => !r.skipped && r.points.length > 0);
  if (withPoints.length > 0) {
    console.log(`  Across ${withPoints.length} repo(s), files whose content genuinely changed:`);
    for (const days of WINDOWS) {
      const vals = withPoints
        .map((r) => r.points.find((p) => p.days === days))
        .filter((p): p is PointResult => !!p && p.touched.sampled > 0)
        .map((p) => p.touched.substantiveRate)
        .sort((a, b) => a - b);
      if (vals.length === 0) continue;
      const q = (f: number): number => vals[Math.min(vals.length - 1, Math.floor(f * vals.length))]!;
      // Median with IQR, never a naked average: refactors change many files at
      // once, so file outcomes are not independent and a point estimate would
      // fake precision this design does not have.
      console.log(
        `    ${String(days).padStart(3)}d  median ${pct(q(0.5)).padStart(6)}` +
          (vals.length >= 4
            ? `   IQR ${pct(q(0.25))}–${pct(q(0.75))}  (n=${vals.length} repos)`
            : `   (n=${vals.length} repo${vals.length === 1 ? "" : "s"} — too few for a spread)`),
      );
    }
    console.log("");
  }

  console.log(
    `  What this does NOT say:\n` +
      `    - it never observes a memory, a recall, or a wrong answer. It measures\n` +
      `      git history, so it cannot show that unchecked memory makes agents\n` +
      `      wrong — only that the code stored facts point at turns over fast;\n` +
      `    - a changed file does not prove a memory became false (a comment fix\n` +
      `      changes the bytes and invalidates nothing) — this OVER-counts;\n` +
      `    - an unchanged file does not prove a memory stayed true (a caller can\n` +
      `      change the behavior it described) — this UNDER-counts, and nothing\n` +
      `      here can measure that channel at all;\n` +
      `    - it says nothing about any other tool's error rate. No competitor\n` +
      `      store was read, generated, or graded.\n` +
      `  It measures DRIFT EXPOSURE: how much stored memory a tool would have to\n` +
      `  re-examine. Tools that never check carry that exposure without knowing.\n`,
  );
  console.log(
    `  Measure your OWN store against your own repo:\n` +
      `    npx memwarden audit <store> --root <repo>\n`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const csvIdx = args.indexOf("--csv");
  const csvPath = csvIdx !== -1 ? args[csvIdx + 1] : undefined;
  // Guard the -1 case: without --csv, `csvIdx + 1` is 0 and would swallow the
  // first repo path.
  const csvValueIdx = csvIdx === -1 ? -1 : csvIdx + 1;
  const paths = args.filter(
    (a, i) => !a.startsWith("--") && i !== csvValueIdx,
  );
  if (paths.length === 0) {
    console.error(
      "usage: npx tsx eval/memory-halflife.ts [--json] [--csv out.csv] <repo-path> [more...]\n\n" +
        "Clone the repos yourself (FULL clones — shallow ones are refused, because\n" +
        "truncated history silently under-reports drift). Nothing is downloaded\n" +
        "here, no memory store is read, and no repo is modified.",
    );
    process.exit(1);
  }
  const results = paths.map(analyzeRepo);

  // Per-file microdata, so anyone can re-cut or re-weight the sample. Hidden
  // weighting is the attack this forecloses.
  if (csvPath) {
    const header = "repo,days,arm,fate,path\n";
    const body = csvRows
      .map(
        (r) =>
          `${r.repo},${r.days},${r.arm},${r.fate},"${r.path.replace(/"/g, '""')}"`,
      )
      .join("\n");
    writeFileSync(csvPath, header + body + "\n", "utf8");
    console.log(`\n  wrote ${csvRows.length} rows of microdata to ${csvPath}`);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        { windows: WINDOWS, activityWindowDays: ACTIVITY_WINDOW_DAYS, results },
        null,
        2,
      ),
    );
    return;
  }
  render(results);
}

main();
