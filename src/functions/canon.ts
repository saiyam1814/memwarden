//
// Core boundary for Verified Memory Canon.
//
// Canon export is deliberately NOT semantic search: it pages over real stored
// Memory rows and applies one exact project-identity predicate. Canon import is
// deliberately NOT observe: it validates the committed record shape, re-hashes
// every referenced file in this checkout, and only then writes a Memory with
// the original title/content/evidence and Canon attestation intact.
//

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CanonRecord, Memory, Provenance } from "./types.js";
import { canonicalizePath } from "./paths.js";
import { projectKey } from "./git-identity.js";
import { classifyProvenance, hashFiles } from "./verify.js";
import {
  getSearchIndex,
  vectorIndexAddGuarded,
  vectorIndexRemove,
} from "./search.js";
import { memoryToObservation } from "./memory-utils.js";

export const CANON_FORMAT = 1;
export const CANON_EXPORT_DEFAULT_PAGE = 250;
export const CANON_EXPORT_MAX_PAGE = 500;

const MEMORY_TYPES = new Set<Memory["type"]>([
  "pattern",
  "preference",
  "architecture",
  "bug",
  "workflow",
  "fact",
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const UNSAFE_MAP_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  max: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0)
  );
}

/** A Canon path must have one portable meaning on every platform and must not
 * be able to make verification read outside the checkout. */
export function isPortableCanonPath(value: unknown): value is string {
  if (!isBoundedString(value, 1024)) return false;
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f:*?"<>|]/.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" "),
    ) ||
    UNSAFE_MAP_KEYS.has(value)
  ) {
    return false;
  }
  return true;
}

function isHashMap(
  value: unknown,
  allowedFiles: Set<string>,
  requireEveryFile: boolean,
): value is Record<string, string> {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (requireEveryFile && keys.length !== allowedFiles.size) return false;
  for (const key of keys) {
    if (
      !allowedFiles.has(key) ||
      !isPortableCanonPath(key) ||
      typeof value[key] !== "string" ||
      !SHA256_RE.test(value[key] as string)
    ) {
      return false;
    }
  }
  if (requireEveryFile) {
    for (const file of allowedFiles) if (!Object.hasOwn(value, file)) return false;
  }
  return true;
}

/** Runtime validation shared by the JSONL reader and the HTTP/core import
 * boundary. Unknown fields are ignored so format-compatible additive writers
 * remain readable, but every trust-bearing field is checked strictly. */
export function isCanonRecord(value: unknown): value is CanonRecord {
  if (!isObject(value)) return false;
  if (value["format"] !== CANON_FORMAT) return false;
  if (!isBoundedString(value["id"], 512)) return false;
  if (!isBoundedString(value["title"], 10_000, true)) return false;
  if (!isBoundedString(value["content"], 1_000_000, true)) return false;
  if (!MEMORY_TYPES.has(value["type"] as Memory["type"])) return false;
  if (
    !Array.isArray(value["concepts"]) ||
    value["concepts"].length > 256 ||
    !value["concepts"].every((v) => isBoundedString(v, 256, true))
  ) {
    return false;
  }
  if (
    !Array.isArray(value["files"]) ||
    value["files"].length === 0 ||
    value["files"].length > 256 ||
    !value["files"].every(isPortableCanonPath)
  ) {
    return false;
  }
  const files = new Set(value["files"] as string[]);
  if (files.size !== value["files"].length) return false;
  if (!isHashMap(value["fileHashes"], files, true)) return false;
  if (
    value["fileHashesNormalized"] !== undefined &&
    !isHashMap(value["fileHashesNormalized"], files, false)
  ) {
    return false;
  }
  if (value["projectKey"] !== undefined) {
    if (
      !isBoundedString(value["projectKey"], 2048) ||
      !(value["projectKey"] as string).startsWith("git:") ||
      /[\u0000-\u001f\u007f\s]/.test(value["projectKey"] as string)
    ) {
      return false;
    }
  }
  if (
    !isBoundedString(value["promotedAt"], 128) ||
    !Number.isFinite(Date.parse(value["promotedAt"] as string))
  ) {
    return false;
  }
  if (value["capturedBy"] !== undefined) {
    if (!isObject(value["capturedBy"])) return false;
    const by = value["capturedBy"];
    if (by["host"] !== undefined && !isBoundedString(by["host"], 256)) {
      return false;
    }
    if (by["agentId"] !== undefined && !isBoundedString(by["agentId"], 256)) {
      return false;
    }
  }
  for (const key of ["reanchoredBy", "reanchoredAt"] as const) {
    if (value[key] !== undefined && !isBoundedString(value[key], 512)) return false;
  }
  if (
    value["reanchoredAt"] !== undefined &&
    !Number.isFinite(Date.parse(value["reanchoredAt"] as string))
  ) {
    return false;
  }
  return true;
}

export interface CanonProjectIdentity {
  root: string;
  key: string;
}

export function canonProjectIdentity(root: string): CanonProjectIdentity {
  if (typeof root !== "string" || !root.trim() || !isAbsolute(root.trim())) {
    throw new Error("root must be an absolute project directory");
  }
  const canonicalRoot = canonicalizePath(root);
  try {
    if (!statSync(canonicalRoot).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error("root must be an existing project directory");
  }
  return { root: canonicalRoot, key: projectKey(canonicalRoot) };
}

/** Exact project membership for Memory rows. New rows carry projectKey.
 * Legacy consolidated rows stored that same stable key in `project`, while
 * older/path-only rows stored the checkout path; both remain readable. */
export function memoryMatchesCanonProject(
  memory: Memory,
  identity: CanonProjectIdentity,
): boolean {
  if (memory.projectKey !== undefined) return memory.projectKey === identity.key;
  if (!memory.project) return false;
  return (
    memory.project === identity.key ||
    canonicalizePath(memory.project) === identity.root
  );
}

export interface CanonExportPage {
  project: CanonProjectIdentity;
  memories: Memory[];
  nextCursor?: string;
}

/** Bounded, project-scoped inventory of real stored Memory records. Pagination
 * is id-based and deterministic; no ranking/index/search result is involved. */
export async function listCanonMemories(
  kv: StateKV,
  input: { root: string; cursor?: string; limit?: number },
): Promise<CanonExportPage> {
  const identity = canonProjectIdentity(input.root);
  const limit = input.limit ?? CANON_EXPORT_DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > CANON_EXPORT_MAX_PAGE) {
    throw new Error(`limit must be an integer between 1 and ${CANON_EXPORT_MAX_PAGE}`);
  }
  if (
    input.cursor !== undefined &&
    (!isBoundedString(input.cursor, 512) || input.cursor.includes("\0"))
  ) {
    throw new Error("cursor must be a non-empty Memory id");
  }

  const all = await kv.list<Memory>(KV.memories);
  const matching = all
    .filter(
      (memory) =>
        memory &&
        typeof memory.id === "string" &&
        memory.isLatest !== false &&
        memoryMatchesCanonProject(memory, identity),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const afterCursor = input.cursor
    ? matching.filter((memory) => memory.id > input.cursor!)
    : matching;
  const memories = afterCursor.slice(0, limit);
  const nextCursor =
    afterCursor.length > memories.length ? memories[memories.length - 1]?.id : undefined;
  return {
    project: identity,
    memories,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export type CanonImportFailureCode =
  | "invalid_record"
  | "project_mismatch"
  | "hash_mismatch"
  | "id_conflict";

export type CanonImportResult =
  | {
      ok: true;
      imported: true;
      id: string;
      projectKey: string;
      verdict: "verified";
    }
  | {
      ok: false;
      code: CanonImportFailureCode;
      error: string;
      id?: string;
    };

/** Validate + locally verify + import one Canon record. There is intentionally
 * no input named `verified`: the only path to a verified recall verdict is the
 * hash comparison below (and recall repeats it later). */
export async function importCanonRecord(
  kv: StateKV,
  input: { root: string; record: unknown },
): Promise<CanonImportResult> {
  if (!isCanonRecord(input.record)) {
    return {
      ok: false,
      code: "invalid_record",
      error: "record is not a valid supported Canon record",
    };
  }
  const record = input.record;
  let identity: CanonProjectIdentity;
  try {
    identity = canonProjectIdentity(input.root);
  } catch (err) {
    return {
      ok: false,
      code: "invalid_record",
      error: err instanceof Error ? err.message : String(err),
      id: record.id,
    };
  }

  if (record.projectKey && record.projectKey !== identity.key) {
    return {
      ok: false,
      code: "project_mismatch",
      error: "Canon record belongs to a different project identity",
      id: record.id,
    };
  }

  // Exact raw capture hashes are the trust boundary. A normalized/cosmetic
  // match is useful for `canon verify`, but it cannot become a stored
  // `verified` Memory because classifyProvenance verifies raw hashes.
  const actual = hashFiles(record.files, identity.root);
  for (const file of record.files) {
    if (actual[file] !== record.fileHashes[file]) {
      return {
        ok: false,
        code: "hash_mismatch",
        error: `Canon evidence does not match this checkout: ${file}`,
        id: record.id,
      };
    }
  }

  const existing = await kv.get<Memory>(KV.memories, record.id).catch(() => null);
  if (existing && !memoryMatchesCanonProject(existing, identity)) {
    return {
      ok: false,
      code: "id_conflict",
      error: "a Memory with this id already belongs to another project",
      id: record.id,
    };
  }

  const canonProjectKey = record.projectKey ?? identity.key;
  const provenance: Provenance = {
    cwd: identity.root,
    files: [...record.files],
    fileHashes: { ...record.fileHashes },
    command: "canon pull",
    userConfirmed: false,
    ...(record.capturedBy?.host ? { agent: record.capturedBy.host } : {}),
    canon: {
      format: record.format,
      recordId: record.id,
      projectKey: canonProjectKey,
      promotedAt: record.promotedAt,
      ...(record.capturedBy
        ? { capturedBy: { ...record.capturedBy } }
        : {}),
      ...(record.reanchoredBy ? { reanchoredBy: record.reanchoredBy } : {}),
      ...(record.reanchoredAt ? { reanchoredAt: record.reanchoredAt } : {}),
    },
  };

  // Defense in depth and a second, immediately-pre-write hash check. This also
  // proves the stored Provenance shape itself classifies as verified; caller
  // prose or attestation metadata cannot influence the result.
  const verdict = classifyProvenance(provenance, identity.root, {
    verifyAgainstRoot: true,
  });
  if (verdict.status !== "verified") {
    return {
      ok: false,
      code: "hash_mismatch",
      error: `Canon evidence is not locally verified: ${verdict.reason}`,
      id: record.id,
    };
  }

  const now = new Date().toISOString();
  const memory: Memory = {
    ...(existing ?? {}),
    id: record.id,
    createdAt: existing?.createdAt ?? record.promotedAt,
    updatedAt: now,
    type: record.type,
    title: record.title,
    content: record.content,
    concepts: [...record.concepts],
    files: [...record.files],
    sessionIds: existing?.sessionIds ?? [],
    strength: existing?.strength ?? 5,
    version: (existing?.version ?? 0) + 1,
    isLatest: true,
    project: identity.root,
    projectKey: canonProjectKey,
    provenance,
    ...(record.capturedBy?.agentId
      ? { agentId: record.capturedBy.agentId }
      : {}),
  };

  await kv.set(KV.memories, memory.id, memory);
  const index = getSearchIndex();
  index.remove(memory.id);
  index.add(memoryToObservation(memory));
  vectorIndexRemove(memory.id);
  await vectorIndexAddGuarded(
    memory.id,
    memory.sessionIds[0] ?? "canon",
    `${memory.title} ${memory.content}`,
    { kind: "memory", logId: memory.id },
  );

  return {
    ok: true,
    imported: true,
    id: memory.id,
    projectKey: canonProjectKey,
    verdict: "verified",
  };
}

export function registerCanonFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::canon-export",
    async (input: { root: string; cursor?: string; limit?: number }) =>
      listCanonMemories(kv, input),
  );
  sdk.registerFunction(
    "mem::canon-import",
    async (input: { root: string; record: unknown }) =>
      importCanonRecord(kv, input),
  );
}
