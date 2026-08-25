// Scriptable CLI adapters for the bounded Memory management HTTP surface.

import { resolve } from "node:path";
import type {
  ManagedHistoryResult,
  ManagedMemoryDetails,
  ManagedMemoryListPage,
  ManagedMemorySummary,
  ProjectListPage,
} from "../functions/management.js";
import { sanitizeUntrustedLine } from "../functions/injection-format.js";
import { getSecret } from "../functions/config.js";
import { readDaemonLogs } from "./logs.js";

export interface ManagementCliDeps {
  baseUrl: string;
  headers(): Record<string, string>;
  cwd?: string;
}

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
}

function parseArgs(
  args: string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): ParsedArgs {
  const valueSet = new Set(valueFlags);
  const booleanSet = new Set(booleanFlags);
  const parsed: ParsedArgs = {
    positionals: [],
    values: new Map(),
    booleans: new Set(),
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }
    if (booleanSet.has(arg)) {
      parsed.booleans.add(arg);
      continue;
    }
    if (!valueSet.has(arg)) throw new Error(`unknown option: ${arg}`);
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    const existing = parsed.values.get(arg) ?? [];
    existing.push(value);
    parsed.values.set(arg, existing);
    index++;
  }
  return parsed;
}

function value(parsed: ParsedArgs, flag: string): string | undefined {
  return parsed.values.get(flag)?.at(-1);
}

function values(parsed: ParsedArgs, ...flags: string[]): string[] {
  const out: string[] = [];
  for (const flag of flags) {
    for (const raw of parsed.values.get(flag) ?? []) {
      out.push(...raw.split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  return Array.from(new Set(out));
}

function integer(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${flag} requires an integer`);
  return parsed;
}

function projectPath(parsed: ParsedArgs, cwd: string): string {
  return resolve(value(parsed, "--project") ?? cwd);
}

function cleanLine(value: string, maximum = 512): string {
  return sanitizeUntrustedLine(value).slice(0, maximum);
}

async function postJson<T>(
  deps: ManagementCliDeps,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${deps.baseUrl}${path}`, {
    method: "POST",
    headers: deps.headers(),
    body: JSON.stringify(body),
  });
  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch {
    decoded = null;
  }
  if (!response.ok) {
    const message =
      decoded && typeof decoded === "object" && "error" in decoded
        ? String((decoded as { error?: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(
      `${path.replace("/memwarden/", "")} failed: ${cleanLine(message, 2_000)}`,
    );
  }
  return decoded as T;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function renderMemoryLine(memory: ManagedMemorySummary): string {
  const lifecycle =
    memory.lifecycle.effective === "active"
      ? ""
      : ` [${memory.lifecycle.effective}]`;
  return `  [${memory.status}]${lifecycle} ${memory.kind} v${memory.version} ${cleanLine(memory.id)}  ${cleanLine(memory.title)}`;
}

function memoriesUsage(): string {
  return (
    "usage:\n" +
    "  memwarden memories list [--project dir|--all-projects] [--status s] [--lifecycle s] [--kind k] [--file path] [--agent a] [--after date] [--before date] [--limit N] [--cursor token] [--json]\n" +
    "  memwarden memories search <query> [--project dir] [--mode current|historical|all|as_of] [--as-of date] [--file path] [--status s] [--limit N] [--json]\n" +
    "  memwarden memories show <id> [--project dir] [--content] [--json]\n" +
    "  memwarden memories edit <id> --title text --text text --authored-by user|agent (--file path... | --no-file-evidence) [--agent name] [--kind k] [--project dir] [--json]\n" +
    "  memwarden memories archive <id> --reason text [--actor name] [--project dir] [--json]\n" +
    "  memwarden memories revalidate <id> --yes --reason text [--actor name] [--project dir] [--json]\n" +
    "  memwarden memories history <id> [--project dir] [--limit N] [--json]\n\n" +
    "list is content-free and uses a signed, filter-bound keyset cursor. edit creates a successor; archive keeps history; revalidate never runs without --yes."
  );
}

async function memoriesList(args: string[], deps: ManagementCliDeps): Promise<void> {
  const parsed = parseArgs(
    args,
    [
      "--project",
      "--status",
      "--lifecycle",
      "--kind",
      "--file",
      "--agent",
      "--after",
      "--from",
      "--before",
      "--to",
      "--limit",
      "--cursor",
    ],
    ["--all-projects", "--json"],
  );
  if (parsed.positionals.length > 0) {
    throw new Error("memories list does not accept positional arguments");
  }
  if (parsed.booleans.has("--all-projects") && value(parsed, "--project")) {
    throw new Error("--project and --all-projects cannot be used together");
  }
  const status = values(parsed, "--status");
  const lifecycle = values(parsed, "--lifecycle");
  const kind = values(parsed, "--kind");
  const file = values(parsed, "--file");
  const limit = integer(value(parsed, "--limit"), "--limit");
  const after = value(parsed, "--after") ?? value(parsed, "--from");
  const before = value(parsed, "--before") ?? value(parsed, "--to");
  const allProjects = parsed.booleans.has("--all-projects");
  const body: Record<string, unknown> = {
    ...(allProjects
      ? { all_projects: true }
      : { project: projectPath(parsed, deps.cwd ?? process.cwd()) }),
    ...(status.length ? { status } : {}),
    ...(lifecycle.length ? { lifecycle } : {}),
    ...(kind.length ? { kind } : {}),
    ...(file.length ? { file } : {}),
    ...(value(parsed, "--agent") ? { agent: value(parsed, "--agent") } : {}),
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(value(parsed, "--cursor") ? { cursor: value(parsed, "--cursor") } : {}),
  };
  const result = await postJson<ManagedMemoryListPage>(
    deps,
    "/memwarden/memories/list",
    body,
  );
  if (parsed.booleans.has("--json")) return printJson(result);
  const scope = "allProjects" in result.scope
    ? "all projects (explicit)"
    : result.scope.projectPath;
  console.log(`\nmemwarden memories — ${cleanLine(scope, 4_096)}\n`);
  if (result.items.length === 0) console.log("  no matching memories.");
  for (const memory of result.items) console.log(renderMemoryLine(memory));
  if (result.nextCursor) {
    console.log(`\n  next cursor: ${result.nextCursor}`);
  }
  if (result.scanCapped) {
    console.log("  scan cap reached; continue with the next cursor.");
  }
  console.log("");
}

interface SearchResultBody {
  contract: string;
  mode?: string;
  results: Array<{
    obsId: string;
    title: string;
    type: string;
    score: number;
    source_status: string;
    evidence_trust: string;
    live_source_status: string;
    persisted_lifecycle: string;
    effective_lifecycle: string;
    historical: boolean;
    lifecycle_as_of?: string;
  }>;
  truncated?: boolean;
  as_of?: Record<string, unknown>;
}

async function memoriesSearch(args: string[], deps: ManagementCliDeps): Promise<void> {
  const parsed = parseArgs(
    args,
    ["--project", "--mode", "--as-of", "--file", "--status", "--limit"],
    ["--json"],
  );
  const query = parsed.positionals.join(" ").trim();
  if (!query) throw new Error("usage: memwarden memories search <query> [options]");
  const mode = value(parsed, "--mode") ?? (value(parsed, "--as-of") ? "as_of" : "current");
  const files = values(parsed, "--file");
  const trust = values(parsed, "--status");
  const limit = integer(value(parsed, "--limit"), "--limit");
  const result = await postJson<SearchResultBody>(
    deps,
    "/memwarden/memories/search",
    {
      query,
      project: projectPath(parsed, deps.cwd ?? process.cwd()),
      mode,
      ...(value(parsed, "--as-of") ? { as_of: value(parsed, "--as-of") } : {}),
      ...(files.length ? { files } : {}),
      ...(trust.length ? { trust } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
  );
  if (parsed.booleans.has("--json")) return printJson(result);
  console.log(`\nmemwarden memories search — ${mode}\n`);
  if (result.results.length === 0) console.log("  no matching memories.");
  for (const item of result.results) {
    const lifecycle = item.effective_lifecycle === "active"
      ? ""
      : ` [${item.effective_lifecycle}]`;
    const temporal = item.lifecycle_as_of ? " [as-of]" : "";
    console.log(
      `  [${item.source_status}]${lifecycle}${temporal} ${cleanLine(item.obsId)}  ${cleanLine(item.title)}`,
    );
  }
  console.log("");
}

async function memoriesShow(args: string[], deps: ManagementCliDeps): Promise<void> {
  const parsed = parseArgs(args, ["--project"], ["--content", "--json"]);
  const id = parsed.positionals[0];
  if (!id || parsed.positionals.length !== 1) {
    throw new Error("usage: memwarden memories show <id> [--content] [--json]");
  }
  const result = await postJson<ManagedMemoryDetails>(
    deps,
    "/memwarden/memories/show",
    {
      memory_id: id,
      project: projectPath(parsed, deps.cwd ?? process.cwd()),
      include_content: parsed.booleans.has("--content"),
    },
  );
  if (parsed.booleans.has("--json")) return printJson(result);
  const memory = result.memory;
  console.log(`\nmemwarden memory — ${cleanLine(memory.id)}\n`);
  console.log(`  title       ${cleanLine(memory.title)}`);
  console.log(`  kind        ${memory.kind} · version ${memory.version}`);
  console.log(`  status      ${memory.status}`);
  console.log(
    `  evidence    ${memory.evidence.trust} — ${cleanLine(memory.evidence.reason, 2_000)}`,
  );
  console.log(
    `  source      ${memory.source.status} — ${cleanLine(memory.source.reason, 2_000)}`,
  );
  console.log(
    `  lifecycle   persisted ${memory.lifecycle.persisted} · effective ${memory.lifecycle.effective}`,
  );
  console.log(`  project     ${cleanLine(memory.project.path ?? "unknown", 4_096)}`);
  console.log(
    `  lineage     supersedes ${memory.lineage.supersedes.length}` +
      (memory.lineage.supersededBy
        ? ` · superseded by ${cleanLine(memory.lineage.supersededBy)}`
        : ""),
  );
  if (result.evidence.files.length === 0) {
    console.log("  files       none (user/command confirmation may still be evidence)");
  } else {
    console.log("  files");
    for (const file of result.evidence.files) {
      console.log(
        `    ${cleanLine(file.path, 1_024)}${file.sha256 ? `  sha256:${file.sha256.slice(0, 12)}…` : "  (no capture hash)"}`,
      );
    }
  }
  if (result.content) {
    console.log(`\n${result.content.framed}`);
    if (result.content.truncated) {
      console.log(
        `\n  content capped for display (${result.content.originalChars} original characters).`,
      );
    }
  } else {
    console.log("\n  content withheld by default; add --content to inspect it as framed untrusted data.");
  }
  console.log("");
}

async function memoriesEdit(args: string[], deps: ManagementCliDeps): Promise<void> {
  const parsed = parseArgs(
    args,
    ["--project", "--title", "--text", "--authored-by", "--file", "--agent", "--kind"],
    ["--no-file-evidence", "--json"],
  );
  const id = parsed.positionals[0];
  if (!id || parsed.positionals.length !== 1) {
    throw new Error("usage: memwarden memories edit <id> --title ... --text ... [evidence options]");
  }
  const title = value(parsed, "--title");
  const text = value(parsed, "--text");
  const authoredBy = value(parsed, "--authored-by");
  if (!title || !text || !authoredBy) {
    throw new Error("edit requires --title, --text, and --authored-by user|agent");
  }
  if (authoredBy !== "user" && authoredBy !== "agent") {
    throw new Error("--authored-by must be user or agent");
  }
  if (authoredBy === "agent" && !value(parsed, "--agent")) {
    throw new Error("--agent is required when --authored-by agent");
  }
  const files = values(parsed, "--file");
  const noFileEvidence = parsed.booleans.has("--no-file-evidence");
  if ((files.length > 0) === noFileEvidence) {
    throw new Error("choose exactly one: one or more --file values, or --no-file-evidence");
  }
  const result = await postJson<{
    ok: true;
    predecessor: ManagedMemorySummary;
    successor: ManagedMemorySummary;
  }>(deps, "/memwarden/memories/edit", {
    memory_id: id,
    project: projectPath(parsed, deps.cwd ?? process.cwd()),
    title,
    text,
    authored_by: authoredBy,
    ...(files.length ? { files } : { no_file_evidence: true }),
    ...(value(parsed, "--agent") ? { agent: value(parsed, "--agent") } : {}),
    ...(value(parsed, "--kind") ? { kind: value(parsed, "--kind") } : {}),
  });
  if (parsed.booleans.has("--json")) return printJson(result);
  console.log(
    `\n  created successor ${result.successor.id} (v${result.successor.version})\n` +
      `  predecessor ${result.predecessor.id} is ${result.predecessor.lifecycle.persisted}; its content/evidence history was preserved.\n`,
  );
}

async function managedTransition(
  action: "archive" | "revalidate",
  args: string[],
  deps: ManagementCliDeps,
): Promise<void> {
  const parsed = parseArgs(
    args,
    ["--project", "--reason", "--actor"],
    ["--yes", "--json"],
  );
  const id = parsed.positionals[0];
  const reason = value(parsed, "--reason");
  if (!id || parsed.positionals.length !== 1 || !reason) {
    throw new Error(
      `usage: memwarden memories ${action} <id> ${action === "revalidate" ? "--yes " : ""}--reason <text> [--json]`,
    );
  }
  if (action === "revalidate" && !parsed.booleans.has("--yes")) {
    throw new Error(
      "revalidation can mint fresh evidence only after deliberate review; re-run with --yes and --reason",
    );
  }
  const result = await postJson<Record<string, unknown>>(
    deps,
    `/memwarden/memories/${action}`,
    {
      memory_id: id,
      project: projectPath(parsed, deps.cwd ?? process.cwd()),
      reason,
      actor: value(parsed, "--actor") ?? "cli",
      ...(action === "revalidate" ? { confirmed: true } : {}),
    },
  );
  if (parsed.booleans.has("--json")) return printJson(result);
  const successor = result["successor"] as { id?: string } | undefined;
  console.log(`\n  ${cleanLine(id)}: ${action} recorded — ${cleanLine(reason, 1_000)}`);
  if (successor?.id) {
    console.log(`  successor evidence version: ${cleanLine(successor.id)}`);
  }
  console.log(
    action === "archive"
      ? "  history remains stored; archive is not forget or erase.\n"
      : "  confirmation and reason were recorded through the lifecycle boundary.\n",
  );
}

async function memoriesHistory(args: string[], deps: ManagementCliDeps): Promise<void> {
  const parsed = parseArgs(args, ["--project", "--limit"], ["--json"]);
  const id = parsed.positionals[0];
  if (!id || parsed.positionals.length !== 1) {
    throw new Error("usage: memwarden memories history <id> [--limit N] [--json]");
  }
  const limit = integer(value(parsed, "--limit"), "--limit");
  const result = await postJson<ManagedHistoryResult>(
    deps,
    "/memwarden/memories/history",
    {
      memory_id: id,
      project: projectPath(parsed, deps.cwd ?? process.cwd()),
      ...(limit !== undefined ? { limit } : {}),
    },
  );
  if (parsed.booleans.has("--json")) return printJson(result);
  console.log(`\nmemwarden memory history — ${cleanLine(result.rootId)}\n`);
  for (const memory of result.items) console.log(renderMemoryLine(memory));
  if (result.cycleDetected) console.log("\n  warning: malformed lineage cycle detected; traversal stayed bounded.");
  if (result.truncated) console.log(`\n  truncated at ${result.limit} linked versions.`);
  if (result.unresolvedLinks > 0) {
    console.log(`\n  ${result.unresolvedLinks} link(s) were missing or outside this project.`);
  }
  console.log("");
}

export async function runMemoriesCommand(
  args: string[],
  deps: ManagementCliDeps,
): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
      return memoriesList(rest, deps);
    case "search":
      return memoriesSearch(rest, deps);
    case "show":
      return memoriesShow(rest, deps);
    case "edit":
      return memoriesEdit(rest, deps);
    case "archive":
      return managedTransition("archive", rest, deps);
    case "revalidate":
      return managedTransition("revalidate", rest, deps);
    case "history":
      return memoriesHistory(rest, deps);
    default:
      console.log(memoriesUsage());
      if (subcommand) process.exitCode = 1;
  }
}

export async function runProjectsCommand(
  args: string[],
  deps: ManagementCliDeps,
): Promise<void> {
  const parsed = parseArgs(args, ["--limit", "--cursor"], ["--json"]);
  if (parsed.positionals.length > 0) {
    throw new Error("usage: memwarden projects [--limit N] [--cursor token] [--json]");
  }
  const limit = integer(value(parsed, "--limit"), "--limit");
  const result = await postJson<ProjectListPage>(deps, "/memwarden/projects", {
    ...(limit !== undefined ? { limit } : {}),
    ...(value(parsed, "--cursor") ? { cursor: value(parsed, "--cursor") } : {}),
  });
  if (parsed.booleans.has("--json")) return printJson(result);
  console.log("\nmemwarden projects\n");
  if (result.projects.length === 0) console.log("  no projects in this brain.");
  for (const project of result.projects) {
    console.log(`  ${cleanLine(project.path ?? "(unscoped legacy records)", 4_096)}`);
    console.log(`    key         ${cleanLine(project.key ?? "none", 4_096)}`);
    console.log(`    memories    ${project.counts.memories}`);
    console.log(
      `    evidence    verified ${project.counts.evidence.verified} · sourced ${project.counts.evidence.sourced} · unsourced ${project.counts.evidence.unsourced}`,
    );
    console.log(
      `    source      matched ${project.counts.source.matched} · cosmetic ${project.counts.source.cosmetic_drift} · drifted ${project.counts.source.drifted} · missing ${project.counts.source.missing} · unknown ${project.counts.source.unknown}`,
    );
    console.log(
      `    status      verified ${project.counts.status.verified} · sourced ${project.counts.status.sourced_unverified} · stale ${project.counts.status.stale} · unsourced ${project.counts.status.unsourced} · unverifiable ${project.counts.status.unverifiable}`,
    );
    console.log(
      `    lifecycle   active ${project.counts.lifecycle.active} · needs_revalidation ${project.counts.lifecycle.needs_revalidation} · disputed ${project.counts.lifecycle.disputed} · archived ${project.counts.lifecycle.archived} · revoked ${project.counts.lifecycle.revoked} · superseded ${project.counts.lifecycle.superseded}`,
    );
    console.log(
      `    activity    ${project.lastActivity ?? "unknown"} · footprint ${humanBytes(project.footprint.estimatedBytes)} estimated`,
    );
  }
  if (result.nextCursor) console.log(`\n  next cursor: ${result.nextCursor}`);
  console.log("");
}

export function runLogsCommand(args: string[]): void {
  const parsed = parseArgs(args, ["--lines"], ["--tail", "--json"]);
  if (parsed.positionals.length > 0) {
    throw new Error("usage: memwarden logs [--tail] [--lines N] [--json]");
  }
  const lines = integer(value(parsed, "--lines"), "--lines");
  const secret = getSecret();
  const result = readDaemonLogs({
    tail: parsed.booleans.has("--tail"),
    ...(lines !== undefined ? { lines } : {}),
    ...(secret ? { secret } : {}),
  });
  if (parsed.booleans.has("--json")) return printJson(result);
  if (!result.exists) {
    console.log(
      `[memwarden] daemon log does not exist yet: ${cleanLine(result.path, 4_096)}`,
    );
    return;
  }
  for (const line of result.lines) console.log(line);
  if (result.truncated) {
    console.log(`[memwarden] output capped at ${result.requestedLines} sanitized lines.`);
  }
}
