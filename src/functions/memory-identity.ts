//
// Memory project identity.
//
// A filesystem path and a stable git-derived project key answer different
// questions: the key decides whether two checkouts belong to the same project;
// the path decides which checkout's files must be read.  Keep both all the way
// through distilled-memory lookup and verification.  The helpers here are also
// the single compatibility boundary for legacy Memory rows whose overloaded
// `project` field may contain either kind of value.
//

import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { projectKey as computeProjectKey } from "./git-identity.js";
import { canonicalizePath } from "./paths.js";
import type { Memory, Session } from "./types.js";

export interface ProjectIdentity {
  /** Capture-time project filesystem path (normally the repository root). */
  projectPath?: string;
  /** Stable git-derived identity, or the canonical path fallback. */
  projectKey?: string;
  /** Capture-time working directory used to interpret relative evidence. */
  captureCwd?: string;
}

export interface ResolvedMemoryIdentity extends ProjectIdentity {
  /** Best source session for legacy metadata and explanation output. */
  sourceSession?: Session;
}

/** Minimal structural shape accepted by the resolver (Canon inventory uses a
 * projection rather than the complete persisted Memory interface). */
export interface MemoryIdentityRecord {
  sessionIds?: string[];
  projectPath?: string;
  projectKey?: string;
  captureCwd?: string;
  project?: string;
  provenance?: { cwd?: string };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Legacy consolidation wrote stable git keys into Memory.project. */
export function isStableProjectKey(value: string | undefined): boolean {
  return value?.startsWith("git:") === true || value?.startsWith("gitroot:") === true;
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && canonicalizePath(a) === canonicalizePath(b);
}

/** Resolve a Session into the same split identity shape used by Memory. */
export function sessionProjectIdentity(session: Session): ProjectIdentity {
  const projectPath = nonEmpty(session.project);
  const captureCwd = nonEmpty(session.cwd);
  // Old sessions predate Session.projectKey.  When their checkout still
  // exists, derive it now so their distilled memories can move with a remote
  // or linked worktree too.  computeProjectKey falls back to the canonical
  // path, so this remains additive for non-git sessions.
  const projectKey =
    nonEmpty(session.projectKey) ??
    (captureCwd ? computeProjectKey(captureCwd) : undefined);
  return {
    ...(projectPath ? { projectPath } : {}),
    ...(projectKey ? { projectKey } : {}),
    ...(captureCwd ? { captureCwd } : {}),
  };
}

/**
 * Split a Memory's identity, consulting its source sessions when fields are
 * absent.  Explicit new fields always win.  Legacy `project` values beginning
 * `git:`/`gitroot:` are keys; other values remain filesystem/project paths.
 * A source session can disambiguate custom historical keys as well.
 */
export function resolveMemoryIdentity(
  memory: MemoryIdentityRecord,
  sessionsById: ReadonlyMap<string, Session> = new Map(),
): ResolvedMemoryIdentity {
  const sourceSessions = (memory.sessionIds ?? [])
    .map((id) => sessionsById.get(id))
    .filter((session): session is Session => session !== undefined);
  const recordedCaptureCwd =
    nonEmpty(memory.captureCwd) ?? nonEmpty(memory.provenance?.cwd);
  const explicitKey = nonEmpty(memory.projectKey);
  const legacyProject = nonEmpty(memory.project);

  let sourceSession = sourceSessions.find((session) =>
    samePath(nonEmpty(session.cwd), recordedCaptureCwd),
  );
  if (!sourceSession && explicitKey) {
    sourceSession = sourceSessions.find(
      (session) => sessionProjectIdentity(session).projectKey === explicitKey,
    );
  }
  if (!sourceSession && legacyProject) {
    sourceSession = sourceSessions.find((session) => {
      const identity = sessionProjectIdentity(session);
      return (
        identity.projectKey === legacyProject ||
        samePath(identity.projectPath, legacyProject) ||
        samePath(identity.captureCwd, legacyProject)
      );
    });
  }
  sourceSession ??= sourceSessions[0];

  const sourceIdentity = sourceSession
    ? sessionProjectIdentity(sourceSession)
    : undefined;
  // Besides the two known prefixes, a source session can prove that a custom
  // legacy value was its key rather than its path.
  const legacyIsKey =
    isStableProjectKey(legacyProject) ||
    sourceSessions.some(
      (session) => sessionProjectIdentity(session).projectKey === legacyProject,
    );
  const projectPath =
    nonEmpty(memory.projectPath) ??
    (!legacyIsKey ? legacyProject : undefined) ??
    sourceIdentity?.projectPath;
  const projectKey =
    explicitKey ??
    (legacyIsKey ? legacyProject : undefined) ??
    sourceIdentity?.projectKey;
  const captureCwd = recordedCaptureCwd ?? sourceIdentity?.captureCwd;

  return {
    ...(projectPath ? { projectPath } : {}),
    ...(projectKey ? { projectKey } : {}),
    ...(captureCwd ? { captureCwd } : {}),
    ...(sourceSession ? { sourceSession } : {}),
  };
}

export function hasProjectIdentity(identity: ProjectIdentity): boolean {
  return !!(identity.projectKey || identity.projectPath || identity.captureCwd);
}

/**
 * Does this captured identity belong to `path`?  Stable identity widens the
 * match across worktrees/clones; path comparison preserves legacy exact-scope
 * behavior.  This function only answers identity.  Verification callers must
 * still pass the actual caller path to classifyProvenance — never the key.
 */
export function projectIdentityMatchesPath(
  identity: ProjectIdentity,
  path: string,
): boolean {
  const target = nonEmpty(path);
  if (!target) return false;
  const targetKey = computeProjectKey(target);
  if (identity.projectKey && identity.projectKey === targetKey) return true;
  const targetPath = canonicalizePath(target);
  return [identity.projectPath, identity.captureCwd].some(
    (candidate) =>
      candidate !== undefined && canonicalizePath(candidate) === targetPath,
  );
}

/** Add the split fields to a legacy row without removing its readable alias. */
export function migrateLegacyMemoryIdentity(
  memory: Memory,
  sessionsById: ReadonlyMap<string, Session> = new Map(),
): Memory {
  const identity = resolveMemoryIdentity(memory, sessionsById);
  return {
    ...memory,
    ...(identity.projectPath ? { projectPath: identity.projectPath } : {}),
    ...(identity.projectKey ? { projectKey: identity.projectKey } : {}),
    ...(identity.captureCwd ? { captureCwd: identity.captureCwd } : {}),
  };
}

/**
 * Canon/export inventory with the same scoping semantics as safe recall and
 * doctor. A scoped inventory fails closed for identity-less rows; legacy rows
 * carrying only `project` are resolved explicitly above and remain readable.
 */
export async function listMemoryInventory(
  kv: StateKV,
  projectPath?: string,
): Promise<Memory[]> {
  const [memories, sessions] = await Promise.all([
    kv.list<Memory>(KV.memories).catch(() => [] as Memory[]),
    kv.list<Session>(KV.sessions).catch(() => [] as Session[]),
  ]);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const scoped = nonEmpty(projectPath);
  const out: Memory[] = [];
  for (const memory of memories) {
    if (memory.isLatest === false) continue;
    const identity = resolveMemoryIdentity(memory, sessionsById);
    if (
      scoped &&
      (!hasProjectIdentity(identity) ||
        !projectIdentityMatchesPath(identity, scoped))
    ) {
      continue;
    }
    out.push(migrateLegacyMemoryIdentity(memory, sessionsById));
  }
  return out;
}
