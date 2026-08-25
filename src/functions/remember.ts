import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { Memory, Provenance } from "./types.js";
import { canonicalizePath } from "./paths.js";
import { projectKey as computeProjectKey } from "./git-identity.js";
import {
  hasProjectIdentity,
  projectIdentityMatchesPath,
  resolveMemoryIdentity,
} from "./memory-identity.js";
import { hashFiles } from "./verify.js";
import {
  getSearchIndex,
  vectorIndexAddGuarded,
  vectorIndexRemove,
} from "./search.js";
import { isMemoryRecallable, memoryToObservation } from "./memory-utils.js";
import {
  applyMemoryLifecycleTransition,
  initializeMemoryLifecycle,
  migrateLegacyMemoryLifecycle,
  persistedLifecycleOf,
} from "./memory-lifecycle.js";
import { withKeyedLock } from "./keyed-mutex.js";

export const MANUAL_MEMORY_KINDS = [
  "pattern",
  "preference",
  "architecture",
  "bug",
  "workflow",
  "fact",
] as const satisfies readonly Memory["type"][];

export interface RememberMemoryInput {
  text: string;
  title?: string;
  kind?: Memory["type"];
  files?: string[];
  expiresAt?: string | null;
  expires_at?: string | null;
  supersedes?: string;
  sessionId?: string;
  project: string;
  agent?: string;
  authoredBy?: Provenance["authoredBy"];
  timestamp?: string;
}

export interface RememberMemoryResult {
  success: boolean;
  observationId?: string;
  memoryId?: string;
  deduplicated?: boolean;
  memory?: Memory;
  reason?: string;
}

const TITLE_MAX_CHARS = 160;
const CONCEPT_STOPWORDS = new Set([
  "about",
  "after",
  "before",
  "from",
  "into",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "with",
]);

function titleFromContent(content: string): string {
  const first = content
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(Boolean) ?? "Saved memory";
  return first.length <= TITLE_MAX_CHARS
    ? first
    : `${first.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

function conceptsFrom(title: string, content: string): string[] {
  const tokens = `${title} ${content}`.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  return Array.from(
    new Set(tokens.filter((token) => !CONCEPT_STOPWORDS.has(token))),
  ).slice(0, 24);
}

function resolveThroughExistingAncestor(path: string): string {
  let probe = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(probe), ...missing.reverse());
    } catch {
      try {
        lstatSync(probe);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`path cannot be resolved safely: ${path}`);
        }
        const parent = dirname(probe);
        if (parent === probe) {
          throw new Error(`path cannot be resolved safely: ${path}`);
        }
        missing.push(basename(probe));
        probe = parent;
        continue;
      }
      throw new Error(`path cannot be resolved safely: ${path}`);
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel.length > 0 &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

export function normalizeManualFiles(project: string, values: string[]): string[] {
  const root = resolveThroughExistingAncestor(project);
  const out = new Set<string>();
  for (const value of values) {
    const file = value.trim();
    if (!file || file.includes("\0")) throw new Error("files must contain valid paths");
    const absolute = resolveThroughExistingAncestor(
      isAbsolute(file) ? file : resolve(root, file),
    );
    if (!isWithin(root, absolute)) {
      throw new Error(`file must be inside the current project: ${file}`);
    }
    out.add(relative(root, absolute).split(sep).join("/"));
  }
  return [...out];
}

function parseExpiry(input: RememberMemoryInput): string | null | undefined {
  const value = input.expiresAt !== undefined ? input.expiresAt : input.expires_at;
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("expires_at must be null or a valid date-time string");
  }
  const trimmed = value.trim();
  if (Number.isNaN(new Date(trimmed).getTime())) {
    throw new Error("expires_at must be null or a valid date-time string");
  }
  return trimmed;
}

function manualMemoryId(
  project: string,
  kind: Memory["type"],
  title: string,
  content: string,
): string {
  return fingerprintId("mem", JSON.stringify([project, kind, title, content]));
}

/**
 * Manual memories live directly in KV.memories. Unless an explicit expiry is
 * supplied, retention sweeps never remove them and access count is irrelevant.
 */
export async function rememberMemory(
  kv: StateKV,
  input: RememberMemoryInput,
): Promise<RememberMemoryResult> {
  if (typeof input?.text !== "string" || !input.text.trim()) {
    return { success: false, reason: "text is required" };
  }
  if (typeof input?.project !== "string" || !input.project.trim()) {
    return { success: false, reason: "project is required" };
  }
  if (
    input.title !== undefined &&
    (typeof input.title !== "string" || !input.title.trim())
  ) {
    return { success: false, reason: "title must be a non-empty string" };
  }
  for (const field of ["supersedes", "sessionId", "agent"] as const) {
    if (
      input[field] !== undefined &&
      (typeof input[field] !== "string" || !input[field].trim())
    ) {
      return { success: false, reason: `${field} must be a non-empty string` };
    }
  }
  if (
    input.authoredBy !== undefined &&
    !["user", "agent", "user_or_agent"].includes(input.authoredBy)
  ) {
    return { success: false, reason: "authoredBy is invalid" };
  }
  if (
    input.timestamp !== undefined &&
    (typeof input.timestamp !== "string" ||
      Number.isNaN(new Date(input.timestamp).getTime()))
  ) {
    return { success: false, reason: "timestamp must be a valid date-time string" };
  }

  const content = input.text;
  const title = input.title ?? titleFromContent(content);
  const kind = input.kind ?? "fact";
  if (!MANUAL_MEMORY_KINDS.includes(kind)) {
    return {
      success: false,
      reason: `kind must be one of: ${MANUAL_MEMORY_KINDS.join(", ")}`,
    };
  }

  const projectPath = canonicalizePath(resolve(input.project.trim()));
  const projectKey = computeProjectKey(projectPath);
  const projectIdentity = projectKey || projectPath;
  let files: string[];
  let expiresAt: string | null | undefined;
  try {
    if (input.files !== undefined && !Array.isArray(input.files)) {
      throw new Error("files must be an array of project-relative paths");
    }
    if (input.files?.some((file) => typeof file !== "string")) {
      throw new Error("files must be an array of project-relative paths");
    }
    files = normalizeManualFiles(projectPath, input.files ?? []);
    expiresAt = parseExpiry(input);
  } catch (err) {
    return {
      success: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const supersedes = input.supersedes?.trim();
  const sessionId = input.sessionId?.trim();
  const agent = input.agent?.trim();
  const timestamp = input.timestamp?.trim() || new Date().toISOString();
  const id = manualMemoryId(projectIdentity, kind, title, content);
  if (supersedes === id) {
    return { success: false, reason: "a memory cannot supersede itself" };
  }

  return withKeyedLock(`remember:${projectIdentity}`, async () => {
    const existing = await kv.get<Memory>(KV.memories, id).catch(() => null);
    const previous = supersedes
      ? await kv.get<Memory>(KV.memories, supersedes).catch(() => null)
      : null;
    if (existing && persistedLifecycleOf(existing) !== "active") {
      return {
        success: false,
        reason: `memory ${id} is ${persistedLifecycleOf(existing)}; use an explicit lifecycle transition or create a superseding version`,
      };
    }
    if (supersedes && !previous) {
      return { success: false, reason: `no memory with id ${supersedes}` };
    }
    const previousIdentity = previous
      ? resolveMemoryIdentity(previous)
      : undefined;
    if (
      previousIdentity &&
      hasProjectIdentity(previousIdentity) &&
      !projectIdentityMatchesPath(previousIdentity, projectPath)
    ) {
      return {
        success: false,
        reason: "supersedes must reference a memory in the current project",
      };
    }

    const provenance: Provenance = {
      cwd: projectPath,
      capturedAt: timestamp,
      userConfirmed: true,
      authoredBy: input.authoredBy ?? "user_or_agent",
    };
    if (agent) provenance.agent = agent;
    if (files.length > 0) {
      provenance.files = files;
      const hashes = hashFiles(files, projectPath);
      if (Object.keys(hashes).length > 0) provenance.fileHashes = hashes;
    }
    if (existing) {
      const priorFiles = [...(existing.provenance?.files ?? existing.files)].sort();
      const nextFiles = [...(provenance.files ?? [])].sort();
      const priorHashes = Object.entries(existing.provenance?.fileHashes ?? {}).sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      );
      const nextHashes = Object.entries(provenance.fileHashes ?? {}).sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      );
      if (
        JSON.stringify(priorFiles) !== JSON.stringify(nextFiles) ||
        JSON.stringify(priorHashes) !== JSON.stringify(nextHashes)
      ) {
        return {
          success: false,
          reason:
            "an existing memory with this content has different source evidence; use revalidate so the prior evidence version is preserved",
        };
      }
    }

    const supersededIds = Array.from(
      new Set([...(existing?.supersedes ?? []), ...(supersedes ? [supersedes] : [])]),
    );
    const sessionIds = Array.from(
      new Set([...(existing?.sessionIds ?? []), ...(sessionId ? [sessionId] : [])]),
    );
    const migratedExisting = existing
      ? migrateLegacyMemoryLifecycle(existing)
      : null;
    const lifecycleFields = migratedExisting
      ? {
          ...(migratedExisting.observedAt
            ? { observedAt: migratedExisting.observedAt }
            : {}),
          ...(migratedExisting.validFrom
            ? { validFrom: migratedExisting.validFrom }
            : {}),
          ...(migratedExisting.validTo
            ? { validTo: migratedExisting.validTo }
            : {}),
          ...(migratedExisting.validityIntervals
            ? { validityIntervals: migratedExisting.validityIntervals }
            : {}),
          lifecycle: migratedExisting.lifecycle!,
          lifecycleReason: migratedExisting.lifecycleReason!,
          ...(migratedExisting.lifecycleChangedAt
            ? { lifecycleChangedAt: migratedExisting.lifecycleChangedAt }
            : {}),
          ...(migratedExisting.lifecycleTransitions
            ? { lifecycleTransitions: migratedExisting.lifecycleTransitions }
            : {}),
          ...(migratedExisting.lifecycleMigratedFromLegacy
            ? { lifecycleMigratedFromLegacy: true as const }
            : {}),
        }
      : initializeMemoryLifecycle(timestamp, "manual memory created", agent);
    const memory: Memory = {
      ...lifecycleFields,
      id,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      type: kind,
      title,
      content,
      concepts: conceptsFrom(title, content),
      files,
      sessionIds,
      strength: 10,
      version: existing
        ? existing.version + 1
        : previous
          ? previous.version + 1
          : 1,
      origin: "manual",
      ...(previous ? { parentId: previous.parentId ?? previous.id } : {}),
      ...(supersededIds.length > 0 ? { supersedes: supersededIds } : {}),
      isLatest: existing?.isLatest !== false,
      retention: expiresAt ? "expires" : "durable",
      ...(expiresAt ? { forgetAfter: expiresAt } : {}),
      ...(agent ? { agentId: agent } : {}),
      projectPath,
      projectKey,
      captureCwd: projectPath,
      provenance,
    };
    let archived: Memory | null = null;
    if (previous) {
      try {
        archived = applyMemoryLifecycleTransition(previous, {
          action: "supersede",
          reason: `Superseded by ${id}`,
          at: timestamp,
          ...(agent ? { actor: agent } : {}),
          supersededBy: id,
        });
      } catch (err) {
        return {
          success: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    try {
      // Fail closed under a concurrent read: close the predecessor before the
      // successor becomes current. If successor installation fails, restore
      // the predecessor and the prior successor slot below.
      if (archived) await kv.set(KV.memories, archived.id, archived);
      await kv.set(KV.memories, id, memory);
    } catch (err) {
      if (archived && previous) {
        await kv.set(KV.memories, previous.id, previous).catch(() => undefined);
      }
      if (existing) await kv.set(KV.memories, id, existing).catch(() => undefined);
      else await kv.delete(KV.memories, id).catch(() => undefined);
      return {
        success: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (archived) {
      getSearchIndex().remove(archived.id);
      vectorIndexRemove(archived.id);
    }
    const observation = memoryToObservation(memory);
    getSearchIndex().remove(id);
    vectorIndexRemove(id);
    if (isMemoryRecallable(memory)) {
      getSearchIndex().add(observation);
      await vectorIndexAddGuarded(
        id,
        observation.sessionId,
        `${memory.title} ${memory.content}`,
        { kind: "memory", logId: id },
      );
    }

    return {
      success: true,
      observationId: id,
      memoryId: id,
      deduplicated: existing !== null,
      memory,
    };
  });
}

export function registerRememberFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::remember",
    (input: RememberMemoryInput): Promise<RememberMemoryResult> =>
      rememberMemory(kv, input),
  );
}
