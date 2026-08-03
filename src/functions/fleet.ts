//
// Fleet registry (#25): which agents are active in a project right now, and
// what they're touching. One row per active agent instance, keyed by
// sessionId, upserted on every capture that reaches mem::observe.
//
// Project scoping mirrors mem::doctor (canonicalized path match) widened by
// projectKey when available — the same comparison order sessionProjectMismatch
// (observe.ts) uses for "is this the same project", so a worktree of the same
// repo counts as one project here too.
//

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { canonicalizePath } from "./paths.js";
import { projectKey as computeProjectKey } from "./git-identity.js";

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
// Bounded so a long session's row doesn't grow without limit; recent files
// are what matters for "what is this agent touching right now".
const MAX_RECENT_FILES = 20;

export interface FleetAgent {
  sessionId: string;
  /** AGENT_ID env var, when the host set one. Usually absent. */
  agentId?: string;
  /** Which tool sent this (claude-code, cursor, ...) — from the hook's
   * `agent` field, present on every capture. */
  host?: string;
  project?: string;
  cwd?: string;
  projectKey?: string;
  branch?: string;
  /** Most-recently-touched files, oldest first, capped at MAX_RECENT_FILES. */
  files: string[];
  captureCount: number;
  lastSeen: string;
}

export interface FleetActivity {
  sessionId: string;
  agentId?: string;
  host?: string;
  project?: string;
  cwd?: string;
  projectKey?: string;
  files?: string[];
  timestamp?: string;
}

/** Walk up from `startDir` to the nearest `.git` entry (dir or worktree file). */
function findDotGit(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const entry = join(dir, ".git");
    if (existsSync(entry)) return entry;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Current branch for a working directory, or undefined when detached HEAD,
 * not a git repo, or unreadable. Reads .git/HEAD directly (no child process,
 * same discipline as git-identity.ts — hooks fire on every tool call). A
 * worktree's `.git` file points at its own per-worktree HEAD, which already
 * names that worktree's branch, so no special-casing is needed beyond
 * resolving where HEAD lives.
 */
export function currentBranch(cwd: string): string | undefined {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  try {
    const entry = findDotGit(cwd);
    if (!entry) return undefined;
    const gitDir = statSync(entry).isDirectory()
      ? entry
      : (() => {
          const content = readFileSync(entry, "utf8");
          const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
          if (!m) return null;
          return isAbsolute(m[1]!) ? m[1]! : resolve(dirname(entry), m[1]!);
        })();
    if (!gitDir) return undefined;
    const headPath = join(gitDir, "HEAD");
    if (!existsSync(headPath)) return undefined;
    const head = readFileSync(headPath, "utf8").trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** Upsert one agent's registry row: bump captureCount, refresh lastSeen, and
 * merge in newly touched files (most-recent last, capped). Best-effort by
 * design — callers (mem::observe) must never let this fail the capture. */
export async function recordFleetActivity(
  kv: StateKV,
  activity: FleetActivity,
): Promise<void> {
  const existing = await kv.get<FleetAgent>(KV.fleetAgents, activity.sessionId);

  const files = existing?.files ? [...existing.files] : [];
  for (const f of activity.files ?? []) {
    const idx = files.indexOf(f);
    if (idx !== -1) files.splice(idx, 1);
    files.push(f);
  }
  while (files.length > MAX_RECENT_FILES) files.shift();

  const branch =
    (activity.cwd ? currentBranch(activity.cwd) : undefined) ?? existing?.branch;
  const agentId = activity.agentId ?? existing?.agentId;
  const host = activity.host ?? existing?.host;
  const project = activity.project ?? existing?.project;
  const cwd = activity.cwd ?? existing?.cwd;
  const projectKeyVal = activity.projectKey ?? existing?.projectKey;

  const row: FleetAgent = {
    sessionId: activity.sessionId,
    files,
    captureCount: (existing?.captureCount ?? 0) + 1,
    lastSeen: activity.timestamp ?? new Date().toISOString(),
    ...(agentId ? { agentId } : {}),
    ...(host ? { host } : {}),
    ...(project ? { project } : {}),
    ...(cwd ? { cwd } : {}),
    ...(projectKeyVal ? { projectKey: projectKeyVal } : {}),
    ...(branch ? { branch } : {}),
  };
  await kv.set(KV.fleetAgents, activity.sessionId, row);
}

/**
 * Agents active in `project` within the last `withinMs` (default 15 minutes),
 * newest first. `project` is a path, matched the same way mem::doctor scopes
 * a project audit (canonicalized path), widened by projectKey when the stored
 * row has one — so a worktree of the same repo still matches.
 */
export async function listActiveAgents(
  kv: StateKV,
  project: string,
  withinMs = DEFAULT_WINDOW_MS,
): Promise<FleetAgent[]> {
  const all = await kv.list<FleetAgent>(KV.fleetAgents);
  const wantPath = canonicalizePath(project);
  const wantKey = computeProjectKey(project);
  const cutoff = Date.now() - withinMs;
  return all
    .filter((a) => {
      if (a.projectKey && a.projectKey === wantKey) return true;
      if (a.project && canonicalizePath(a.project) === wantPath) return true;
      if (a.cwd && canonicalizePath(a.cwd) === wantPath) return true;
      return false;
    })
    .filter((a) => {
      const t = Date.parse(a.lastSeen);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}
