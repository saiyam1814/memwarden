//
// Bounded daily-use Memory management surface.
//
// This module deliberately works over real KV.memories rows, never a magic
// empty semantic search. It reuses the project-identity resolver, provenance
// classifier, durable remember path, and lifecycle transition boundary. Every
// scoped operation requires a real checkout and fails closed for identity-less
// or cross-project rows.
//

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { canonicalize } from "../state/store.js";
import { canonicalizePath } from "./paths.js";
import { projectKey as computeProjectKey } from "./git-identity.js";
import {
  hasProjectIdentity,
  projectIdentityMatchesPath,
  resolveMemoryIdentity,
  type ProjectIdentity,
  type ResolvedMemoryIdentity,
} from "./memory-identity.js";
import {
  MEMORY_LIFECYCLE_STATES,
  isValidRecordedLifecycleTransition,
  lifecycleProjection,
  persistedLifecycleOf,
  validityIntervalsOf,
} from "./memory-lifecycle.js";
import {
  evidenceTrustOf,
  classifyProvenance,
  type EvidenceTrust,
  type LiveSourceStatus,
  type VerifyStatus,
} from "./verify.js";
import {
  MANUAL_MEMORY_KINDS,
  rememberMemory,
} from "./remember.js";
import {
  transitionMemoryLifecycle,
  type TransitionMemoryLifecycleResult,
} from "./lifecycle.js";
import { frameMemoryInspection } from "./injection-format.js";
import { withKeyedLock } from "./keyed-mutex.js";
import type {
  Memory,
  MemoryLifecycleState,
  Provenance,
  Session,
} from "./types.js";

export const MEMORY_LIST_DEFAULT_LIMIT = 50;
export const MEMORY_LIST_MAX_LIMIT = 200;
export const MEMORY_HISTORY_DEFAULT_LIMIT = 50;
export const MEMORY_HISTORY_MAX_LIMIT = 100;
export const PROJECT_LIST_DEFAULT_LIMIT = 100;
export const PROJECT_LIST_MAX_LIMIT = 500;

const STORAGE_PAGE = 250;
const MEMORY_PAGE_SCAN_CAP = 10_000;
const PROJECT_MEMORY_SCAN_CAP = 20_000;
const MAX_SESSION_LINKS = 32;
const MAX_EVIDENCE_FILES = 128;
const MAX_INSPECTION_CONTENT_CHARS = 200_000;
const MAX_FILTER_VALUES = 32;
const MAX_CURSOR_CHARS = 16_384;
const CURSOR_KEY = "management-cursor-hmac-v1";
const CURSOR_VERSION = 1;

export type ManagementStatus = VerifyStatus | "unverifiable";

export class ManagementError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_cursor"
      | "not_found"
      | "project_mismatch"
      | "scan_limit"
      | "transition_failed",
    message: string,
  ) {
    super(message);
    this.name = "ManagementError";
  }
}

export interface ManagedMemorySummary {
  id: string;
  title: string;
  kind: Memory["type"];
  version: number;
  createdAt: string;
  updatedAt: string;
  observedAt?: string;
  validFrom?: string;
  validTo?: string;
  project: { path?: string; key?: string };
  status: ManagementStatus;
  evidence: { trust: EvidenceTrust; reason: string };
  source: { status: LiveSourceStatus; reason: string };
  lifecycle: {
    persisted: MemoryLifecycleState;
    effective: MemoryLifecycleState;
    persistedReason: string;
    effectiveReason: string;
  };
  files: string[];
  fileCount: number;
  filesTruncated: boolean;
  agent?: string;
  lineage: {
    parentId?: string;
    supersedes: string[];
    supersededBy?: string;
  };
  retention?: Memory["retention"];
  forgetAfter?: string;
}

export interface ListManagedMemoriesInput {
  project?: string;
  allProjects?: boolean;
  status?: string[];
  lifecycle?: string[];
  kind?: string[];
  file?: string[];
  agent?: string;
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
}

export interface ManagedMemoryListPage {
  format: "memwarden.memory-list.v1";
  scope: { projectPath: string; projectKey: string } | { allProjects: true };
  order: "memory-id-ascending";
  snapshotAt: string;
  filters: {
    status: ManagementStatus[];
    lifecycle: MemoryLifecycleState[];
    kind: Memory["type"][];
    file: string[];
    agent?: string;
    after?: string;
    before?: string;
  };
  limit: number;
  scanned: number;
  scanCapped: boolean;
  items: ManagedMemorySummary[];
  nextCursor: string | null;
}

interface ManagementVerdict {
  status: ManagementStatus;
  reason: string;
  evidenceTrust: EvidenceTrust;
  evidenceReason: string;
  sourceStatus: LiveSourceStatus;
  sourceReason: string;
}

interface NormalizedListInput {
  root?: string;
  projectKey?: string;
  allProjects: boolean;
  statuses: Set<ManagementStatus>;
  lifecycles: Set<MemoryLifecycleState>;
  kinds: Set<Memory["type"]>;
  files: string[];
  agent?: string;
  after?: string;
  before?: string;
  afterMs?: number;
  beforeMs?: number;
  limit: number;
  filterDescriptor: Record<string, unknown>;
}

interface CursorPayload {
  v: number;
  resource: "memories" | "projects";
  filterHash: string;
  snapshotAt: string;
  after: string;
}

interface IdentityContext {
  sessions: Map<string, Session | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipped(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function isMemoryRecord(value: unknown): value is Memory {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    value["id"].trim().length > 0 &&
    value["id"].length <= 512 &&
    !value["id"].includes("\0") &&
    typeof value["title"] === "string" &&
    typeof value["content"] === "string" &&
    typeof value["createdAt"] === "string" &&
    value["createdAt"].length <= 128 &&
    typeof value["updatedAt"] === "string" &&
    value["updatedAt"].length <= 128 &&
    typeof value["type"] === "string" &&
    Array.isArray(value["files"]) &&
    Array.isArray(value["sessionIds"]) &&
    (MANUAL_MEMORY_KINDS as readonly string[]).includes(value["type"])
  );
}

function requiredId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    value.includes("\0")
  ) {
    throw new ManagementError(
      "invalid_input",
      "memory id must be a non-empty string of at most 512 characters",
    );
  }
  return value.trim();
}

export function managementProjectRoot(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4_096 ||
    !isAbsolute(value)
  ) {
    throw new ManagementError(
      "invalid_input",
      "project must be an existing absolute directory",
    );
  }
  const root = canonicalizePath(value.trim());
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ManagementError(
      "invalid_input",
      "project must be an existing absolute directory",
    );
  }
  return root;
}

function usableRoot(value: string | undefined): string | null {
  if (!value || value.length > 4_096 || !isAbsolute(value)) return null;
  const root = canonicalizePath(value);
  try {
    return statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

function normalizeStringArray(
  value: unknown,
  field: string,
  maxChars: number,
): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_FILTER_VALUES ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !item.trim() ||
        item.length > maxChars ||
        item.includes("\0"),
    )
  ) {
    throw new ManagementError(
      "invalid_input",
      `${field} must be a non-empty array of at most ${MAX_FILTER_VALUES} bounded strings`,
    );
  }
  return Array.from(new Set(value.map((item) => String(item).trim())));
}

function normalizeStatuses(value: unknown): Set<ManagementStatus> {
  const aliases: Record<string, ManagementStatus> = {
    verified: "verified",
    cosmetic: "cosmetic",
    reformatted: "cosmetic",
    sourced: "sourced_unverified",
    sourced_unverified: "sourced_unverified",
    "sourced-unverified": "sourced_unverified",
    stale: "stale",
    drifted: "stale",
    "source-drifted": "stale",
    unsourced: "unsourced",
    unverifiable: "unverifiable",
  };
  const values = normalizeStringArray(value, "status", 64);
  const out = new Set<ManagementStatus>();
  for (const item of values) {
    const normalized = aliases[item.toLowerCase()];
    if (!normalized) {
      throw new ManagementError(
        "invalid_input",
        "status entries must be verified, cosmetic, sourced_unverified, stale, unsourced, or unverifiable",
      );
    }
    out.add(normalized);
  }
  return out;
}

function normalizeLifecycles(value: unknown): Set<MemoryLifecycleState> {
  const values = normalizeStringArray(value, "lifecycle", 64);
  const out = new Set<MemoryLifecycleState>();
  for (const item of values) {
    if (!(MEMORY_LIFECYCLE_STATES as readonly string[]).includes(item)) {
      throw new ManagementError(
        "invalid_input",
        `lifecycle entries must be one of: ${MEMORY_LIFECYCLE_STATES.join(", ")}`,
      );
    }
    out.add(item as MemoryLifecycleState);
  }
  return out;
}

function normalizeKinds(value: unknown): Set<Memory["type"]> {
  const values = normalizeStringArray(value, "kind", 64);
  const out = new Set<Memory["type"]>();
  for (const item of values) {
    if (!(MANUAL_MEMORY_KINDS as readonly string[]).includes(item)) {
      throw new ManagementError(
        "invalid_input",
        `kind entries must be one of: ${MANUAL_MEMORY_KINDS.join(", ")}`,
      );
    }
    out.add(item as Memory["type"]);
  }
  return out;
}

function normalizeDate(value: unknown, field: string): { iso?: string; ms?: number } {
  if (value === undefined) return {};
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ManagementError(
      "invalid_input",
      `${field} must be a valid date-time string`,
    );
  }
  const ms = Date.parse(value);
  return { iso: new Date(ms).toISOString(), ms };
}

function normalizedLimit(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new ManagementError(
      "invalid_input",
      `limit must be an integer between 1 and ${maximum}`,
    );
  }
  return value as number;
}

function normalizeListInput(input: ListManagedMemoriesInput): NormalizedListInput {
  if (!isRecord(input)) {
    throw new ManagementError("invalid_input", "list input must be an object");
  }
  const allProjects = input.allProjects === true;
  if (input.allProjects !== undefined && typeof input.allProjects !== "boolean") {
    throw new ManagementError("invalid_input", "allProjects must be a boolean");
  }
  if (allProjects && input.project !== undefined) {
    throw new ManagementError(
      "invalid_input",
      "project and allProjects cannot be used together",
    );
  }
  if (!allProjects && input.project === undefined) {
    throw new ManagementError(
      "invalid_input",
      "project is required unless allProjects is explicitly true",
    );
  }
  const root = allProjects ? undefined : managementProjectRoot(input.project);
  const projectKey = root ? computeProjectKey(root) : undefined;
  const statuses = normalizeStatuses(input.status);
  const lifecycles = normalizeLifecycles(input.lifecycle);
  const kinds = normalizeKinds(input.kind);
  const files = normalizeStringArray(input.file, "file", 1_024).map((file) =>
    file.replace(/\\/g, "/"),
  );
  let agent: string | undefined;
  if (input.agent !== undefined) {
    if (
      typeof input.agent !== "string" ||
      !input.agent.trim() ||
      input.agent.length > 256 ||
      input.agent.includes("\0")
    ) {
      throw new ManagementError(
        "invalid_input",
        "agent must be a non-empty string of at most 256 characters",
      );
    }
    agent = input.agent.trim();
  }
  const after = normalizeDate(input.after, "after");
  const before = normalizeDate(input.before, "before");
  if (after.ms !== undefined && before.ms !== undefined && after.ms > before.ms) {
    throw new ManagementError("invalid_input", "after must not be later than before");
  }
  const limit = normalizedLimit(
    input.limit,
    MEMORY_LIST_DEFAULT_LIMIT,
    MEMORY_LIST_MAX_LIMIT,
  );
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== "string" ||
      !input.cursor ||
      input.cursor.length > MAX_CURSOR_CHARS)
  ) {
    throw new ManagementError("invalid_cursor", "cursor has an invalid shape");
  }

  const filterDescriptor: Record<string, unknown> = {
    resource: "memories",
    scope: allProjects
      ? { allProjects: true }
      : { projectPath: root, projectKey },
    status: [...statuses].sort(),
    lifecycle: [...lifecycles].sort(),
    kind: [...kinds].sort(),
    file: [...files].sort(),
    agent: agent ?? null,
    after: after.iso ?? null,
    before: before.iso ?? null,
  };
  return {
    ...(root ? { root } : {}),
    ...(projectKey ? { projectKey } : {}),
    allProjects,
    statuses,
    lifecycles,
    kinds,
    files,
    ...(agent ? { agent } : {}),
    ...(after.iso ? { after: after.iso, afterMs: after.ms! } : {}),
    ...(before.iso ? { before: before.iso, beforeMs: before.ms! } : {}),
    limit,
    filterDescriptor,
  };
}

function filterHash(value: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function compareCursorKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Per-StateKV process cache only. The persisted KV.config value is the source
 * of truth, so a fresh StateKV/kernel after daemon restart reloads the same key
 * and can authenticate cursors issued by the prior process. WeakMap avoids
 * retaining short-lived SDK facades and never substitutes for persistence.
 */
const cursorKeyCache = new WeakMap<StateKV, Promise<Buffer>>();

async function cursorKey(kv: StateKV): Promise<Buffer> {
  const cached = cursorKeyCache.get(kv);
  if (cached) return cached;
  const loading = withKeyedLock("management:cursor-key", async () => {
    const stored = await kv.get<string>(KV.config, CURSOR_KEY).catch(() => null);
    if (typeof stored === "string" && /^[A-Za-z0-9_-]{43}$/.test(stored)) {
      const decoded = Buffer.from(stored, "base64url");
      if (decoded.length === 32) return decoded;
    }
    const generated = randomBytes(32);
    await kv.set(KV.config, CURSOR_KEY, generated.toString("base64url"));
    return generated;
  });
  cursorKeyCache.set(kv, loading);
  try {
    return await loading;
  } catch (error) {
    cursorKeyCache.delete(kv);
    throw error;
  }
}

async function encodeCursor(kv: StateKV, payload: CursorPayload): Promise<string> {
  const encoded = Buffer.from(canonicalize(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", await cursorKey(kv))
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${mac}`;
}

async function decodeCursor(
  kv: StateKV,
  token: string,
  resource: CursorPayload["resource"],
  expectedFilterHash: string,
): Promise<CursorPayload> {
  if (!token || token.length > MAX_CURSOR_CHARS) {
    throw new ManagementError("invalid_cursor", "cursor has an invalid shape");
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ManagementError("invalid_cursor", "cursor has an invalid shape");
  }
  const expected = createHmac("sha256", await cursorKey(kv))
    .update(parts[0])
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[1], "base64url");
  } catch {
    throw new ManagementError("invalid_cursor", "cursor authentication failed");
  }
  if (
    supplied.length !== expected.length ||
    supplied.toString("base64url") !== parts[1] ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new ManagementError("invalid_cursor", "cursor authentication failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new ManagementError("invalid_cursor", "cursor payload is invalid");
  }
  if (!isRecord(parsed)) {
    throw new ManagementError("invalid_cursor", "cursor payload is invalid");
  }
  const keys = Object.keys(parsed).sort();
  if (
    canonicalize(keys) !==
      canonicalize(["after", "filterHash", "resource", "snapshotAt", "v"]) ||
    parsed["v"] !== CURSOR_VERSION ||
    parsed["resource"] !== resource ||
    parsed["filterHash"] !== expectedFilterHash ||
    typeof parsed["snapshotAt"] !== "string" ||
    !Number.isFinite(Date.parse(parsed["snapshotAt"])) ||
    typeof parsed["after"] !== "string" ||
    !parsed["after"] ||
    parsed["after"].length > 4_096 ||
    parsed["after"].includes("\0")
  ) {
    throw new ManagementError(
      "invalid_cursor",
      "cursor does not match this resource, scope, or filter set",
    );
  }
  return parsed as unknown as CursorPayload;
}

async function resolveIdentityBounded(
  kv: StateKV,
  memory: Memory,
  context: IdentityContext,
): Promise<ResolvedMemoryIdentity> {
  const direct = resolveMemoryIdentity(memory);
  if (
    direct.projectKey ||
    !Array.isArray(memory.sessionIds) ||
    memory.sessionIds.length === 0
  ) {
    return direct;
  }
  const sessions = new Map<string, Session>();
  for (const sessionId of memory.sessionIds.slice(0, MAX_SESSION_LINKS)) {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512) continue;
    let session = context.sessions.get(sessionId);
    if (session === undefined) {
      session = await kv.get<Session>(KV.sessions, sessionId).catch(() => null);
      context.sessions.set(sessionId, session);
    }
    if (session) sessions.set(sessionId, session);
  }
  return resolveMemoryIdentity(memory, sessions);
}

function rawMemoryFiles(memory: Memory): unknown[] {
  const provenanceFiles = memory.provenance?.files;
  return Array.isArray(provenanceFiles)
    ? provenanceFiles
    : Array.isArray(memory.files)
      ? memory.files
      : [];
}

function boundedMemoryFiles(memory: Memory): string[] {
  return rawMemoryFiles(memory)
    .slice(0, MAX_EVIDENCE_FILES)
    .filter(
      (file): file is string =>
        typeof file === "string" && file.length > 0 && file.length <= 4_096,
    );
}

/** A malformed legacy provenance object must fail closed, not crash inventory. */
function boundedProvenance(
  memory: Memory,
  identity: ProjectIdentity,
): Provenance | undefined {
  const source = memory.provenance;
  const rawFiles = rawMemoryFiles(memory);
  const files = boundedMemoryFiles(memory);
  const evidenceTruncated = rawFiles.length > files.length;
  if (!source && files.length === 0) return undefined;
  if (!source) {
    return {
      files,
      command: "memory",
      ...(evidenceTruncated ? { mixedTrust: true } : {}),
      ...(identity.captureCwd && identity.captureCwd.length <= 4_096
        ? { cwd: identity.captureCwd }
        : {}),
    };
  }
  const hashes = Object.create(null) as Record<string, string>;
  const normalizedHashes = Object.create(null) as Record<string, string>;
  const rawHashes = isRecord(source.fileHashes) ? source.fileHashes : {};
  const rawNormalized = isRecord(source.fileHashesNormalized)
    ? source.fileHashesNormalized
    : {};
  for (const file of files) {
    const hash = rawHashes[file];
    if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) hashes[file] = hash;
    const normalized = rawNormalized[file];
    if (
      typeof normalized === "string" &&
      /^[a-f0-9]{64}$/.test(normalized)
    ) {
      normalizedHashes[file] = normalized;
    }
  }
  const authoredBy = source.authoredBy;
  const safeAuthoredBy =
    authoredBy === "user" ||
    authoredBy === "agent" ||
    authoredBy === "user_or_agent"
      ? authoredBy
      : undefined;
  return {
    files,
    ...(Object.keys(hashes).length > 0 ? { fileHashes: hashes } : {}),
    ...(Object.keys(normalizedHashes).length > 0
      ? { fileHashesNormalized: normalizedHashes }
      : {}),
    ...(typeof source.cwd === "string" && source.cwd.length <= 4_096
      ? { cwd: source.cwd }
      : identity.captureCwd && identity.captureCwd.length <= 4_096
        ? { cwd: identity.captureCwd }
        : {}),
    ...(typeof source.command === "string" && source.command
      ? { command: "recorded command" }
      : {}),
    ...(typeof source.agent === "string" && source.agent
      ? { agent: clipped(source.agent, 256) }
      : {}),
    ...(typeof source.capturedAt === "string" && source.capturedAt
      ? { capturedAt: clipped(source.capturedAt, 128) }
      : {}),
    ...(source.userConfirmed === true ? { userConfirmed: true } : {}),
    ...(safeAuthoredBy ? { authoredBy: safeAuthoredBy } : {}),
    ...(source.mixedTrust === true || evidenceTruncated
      ? { mixedTrust: true }
      : {}),
  };
}

function unavailableVerdict(provenance: Provenance | undefined): ManagementVerdict {
  const evidenceTrust = evidenceTrustOf(provenance);
  const reason =
    "the source checkout is unavailable, so capture-time file evidence cannot be checked";
  return {
    status: "unverifiable",
    reason,
    evidenceTrust,
    evidenceReason:
      evidenceTrust === "verified"
        ? "capture-time file commitments exist, but no live checkout is available"
        : evidenceTrust === "sourced"
          ? "source or confirmation evidence exists without a currently checkable checkout"
          : "no source evidence was captured",
    sourceStatus: "unknown",
    sourceReason: reason,
  };
}

function managementVerdict(
  memory: Memory,
  identity: ProjectIdentity,
  scopedRoot?: string,
): ManagementVerdict {
  const provenance = boundedProvenance(memory, identity);
  const files = provenance?.files ?? [];
  if (files.length === 0) return classifyProvenance(provenance, scopedRoot ?? "/");

  if (scopedRoot) {
    return classifyProvenance(provenance, scopedRoot, { verifyAgainstRoot: true });
  }
  const ownRoot =
    usableRoot(provenance?.cwd) ??
    usableRoot(identity.captureCwd) ??
    usableRoot(identity.projectPath);
  if (!ownRoot) return unavailableVerdict(provenance);
  return classifyProvenance(provenance, ownRoot, {
    verifyAgainstRoot: ownRoot !== usableRoot(provenance?.cwd),
  });
}

function safeScalarId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\0")
    ? value
    : undefined;
}

function safeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .slice(0, 256)
        .filter(
          (item): item is string =>
            typeof item === "string" &&
            item.length > 0 &&
            item.length <= 512 &&
            !item.includes("\0"),
        ),
    ),
  );
}

function summaryFrom(
  memory: Memory,
  identity: ResolvedMemoryIdentity,
  verdict: ManagementVerdict,
): ManagedMemorySummary {
  const projection = lifecycleProjection(
    memory,
    verdict.sourceStatus,
    verdict.status === "unverifiable" ||
      (verdict.evidenceTrust === "verified" && verdict.sourceStatus === "unknown"),
  );
  const rawFileCount = rawMemoryFiles(memory).length;
  const boundedFiles = boundedMemoryFiles(memory);
  const files = Array.from(
    new Set(boundedFiles.map((file) => clipped(file, 1_024))),
  );
  const agent =
    typeof memory.agentId === "string" && memory.agentId
      ? memory.agentId
      : typeof memory.provenance?.agent === "string" && memory.provenance.agent
        ? memory.provenance.agent
        : undefined;
  const parentId = safeScalarId(memory.parentId);
  const supersededBy = safeScalarId(memory.supersededBy);
  return {
    id: memory.id,
    title: clipped(memory.title, 512),
    kind: memory.type,
    version:
      Number.isInteger(memory.version) && memory.version > 0 ? memory.version : 1,
    createdAt: clipped(memory.createdAt, 128),
    updatedAt: clipped(memory.updatedAt, 128),
    ...(typeof memory.observedAt === "string" && memory.observedAt
      ? { observedAt: clipped(memory.observedAt, 128) }
      : {}),
    ...(typeof memory.validFrom === "string" && memory.validFrom
      ? { validFrom: clipped(memory.validFrom, 128) }
      : {}),
    ...(typeof memory.validTo === "string" && memory.validTo
      ? { validTo: clipped(memory.validTo, 128) }
      : {}),
    project: {
      ...(identity.projectPath
        ? { path: clipped(identity.projectPath, 4_096) }
        : {}),
      ...(identity.projectKey ? { key: clipped(identity.projectKey, 4_096) } : {}),
    },
    status: verdict.status,
    evidence: {
      trust: verdict.evidenceTrust,
      reason: clipped(verdict.evidenceReason, 2_000),
    },
    source: {
      status: verdict.sourceStatus,
      reason: clipped(verdict.sourceReason, 2_000),
    },
    lifecycle: {
      persisted: projection.persisted,
      effective: projection.effective,
      persistedReason: clipped(projection.persistedReason, 1_000),
      effectiveReason: clipped(projection.effectiveReason, 1_000),
    },
    files,
    fileCount: rawFileCount,
    filesTruncated: rawFileCount > boundedFiles.length,
    ...(agent ? { agent: clipped(agent, 256) } : {}),
    lineage: {
      ...(parentId ? { parentId } : {}),
      supersedes: safeIdList(memory.supersedes),
      ...(supersededBy ? { supersededBy } : {}),
    },
    ...(memory.retention === "durable" || memory.retention === "expires"
      ? { retention: memory.retention }
      : {}),
    ...(typeof memory.forgetAfter === "string" && memory.forgetAfter
      ? { forgetAfter: clipped(memory.forgetAfter, 128) }
      : {}),
  };
}

function activityTime(memory: Memory): number | null {
  for (const value of [memory.updatedAt, memory.createdAt, memory.observedAt]) {
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function createdAfterSnapshot(memory: Memory, snapshotMs: number): boolean {
  const created = Date.parse(memory.createdAt);
  return Number.isFinite(created) && created > snapshotMs;
}

function filesMatch(memory: Memory, requested: string[]): boolean {
  if (requested.length === 0) return true;
  const actual = new Set(
    boundedMemoryFiles(memory).map((file) => file.replace(/\\/g, "/")),
  );
  return requested.every((file) => actual.has(file));
}

export async function listManagedMemories(
  kv: StateKV,
  input: ListManagedMemoriesInput,
): Promise<ManagedMemoryListPage> {
  const normalized = normalizeListInput(input);
  const expectedHash = filterHash(normalized.filterDescriptor);
  const decoded = input.cursor
    ? await decodeCursor(kv, input.cursor, "memories", expectedHash)
    : null;
  const snapshotAt = decoded?.snapshotAt ?? new Date().toISOString();
  const snapshotMs = Date.parse(snapshotAt);
  let afterKey = decoded?.after;
  let scanned = 0;
  let scanCapped = false;
  let hasMore = false;
  const items: ManagedMemorySummary[] = [];
  const identityContext: IdentityContext = { sessions: new Map() };

  outer: while (scanned < MEMORY_PAGE_SCAN_CAP) {
    const page = await kv.listPage<Memory>(KV.memories, {
      ...(afterKey ? { after: afterKey } : {}),
      limit: Math.min(STORAGE_PAGE, MEMORY_PAGE_SCAN_CAP - scanned),
    });
    if (page.entries.length === 0) {
      hasMore = false;
      break;
    }
    for (let index = 0; index < page.entries.length; index++) {
      const entry = page.entries[index]!;
      afterKey = entry.key;
      scanned++;
      const memory = entry.value;
      if (!isMemoryRecord(memory) || createdAfterSnapshot(memory, snapshotMs)) continue;
      const identity = await resolveIdentityBounded(kv, memory, identityContext);
      if (!normalized.allProjects) {
        if (
          !hasProjectIdentity(identity) ||
          !projectIdentityMatchesPath(identity, normalized.root!)
        ) {
          continue;
        }
      }
      if (normalized.kinds.size > 0 && !normalized.kinds.has(memory.type)) continue;
      if (!filesMatch(memory, normalized.files)) continue;
      const agent = memory.agentId ?? memory.provenance?.agent;
      if (normalized.agent && agent !== normalized.agent) continue;
      const activity = activityTime(memory);
      if (normalized.afterMs !== undefined && (activity === null || activity < normalized.afterMs)) {
        continue;
      }
      if (
        normalized.beforeMs !== undefined &&
        (activity === null || activity > normalized.beforeMs)
      ) {
        continue;
      }
      if (
        normalized.lifecycles.size > 0 &&
        !normalized.lifecycles.has(persistedLifecycleOf(memory))
      ) {
        continue;
      }
      const verdict = managementVerdict(memory, identity, normalized.root);
      const summary = summaryFrom(memory, identity, verdict);
      if (
        normalized.statuses.size > 0 &&
        !normalized.statuses.has(summary.status)
      ) {
        continue;
      }
      items.push(summary);
      if (items.length >= normalized.limit) {
        hasMore = index < page.entries.length - 1 || page.hasMore;
        break outer;
      }
    }
    hasMore = page.hasMore;
    if (!page.hasMore) break;
  }
  if (scanned >= MEMORY_PAGE_SCAN_CAP && hasMore && items.length < normalized.limit) {
    scanCapped = true;
  }

  const nextCursor =
    hasMore && afterKey
      ? await encodeCursor(kv, {
          v: CURSOR_VERSION,
          resource: "memories",
          filterHash: expectedHash,
          snapshotAt,
          after: afterKey,
        })
      : null;
  return {
    format: "memwarden.memory-list.v1",
    scope: normalized.allProjects
      ? { allProjects: true }
      : {
          projectPath: normalized.root!,
          projectKey: clipped(normalized.projectKey!, 4_096),
        },
    order: "memory-id-ascending",
    snapshotAt,
    filters: {
      status: [...normalized.statuses].sort(),
      lifecycle: [...normalized.lifecycles].sort(),
      kind: [...normalized.kinds].sort(),
      file: [...normalized.files].sort(),
      ...(normalized.agent ? { agent: normalized.agent } : {}),
      ...(normalized.after ? { after: normalized.after } : {}),
      ...(normalized.before ? { before: normalized.before } : {}),
    },
    limit: normalized.limit,
    scanned,
    scanCapped,
    items,
    nextCursor,
  };
}

async function scopedMemory(
  kv: StateKV,
  idValue: unknown,
  projectValue: unknown,
  context: IdentityContext = { sessions: new Map() },
): Promise<{
  memory: Memory;
  identity: ResolvedMemoryIdentity;
  root: string;
} | null> {
  const id = requiredId(idValue);
  const root = managementProjectRoot(projectValue);
  const memory = await kv.get<Memory>(KV.memories, id).catch(() => null);
  // A malformed/cross-project row is deliberately indistinguishable from a
  // miss at this surface: callers cannot use ids to probe another project.
  if (!memory || !isMemoryRecord(memory)) return null;
  const identity = await resolveIdentityBounded(kv, memory, context);
  if (
    !hasProjectIdentity(identity) ||
    !projectIdentityMatchesPath(identity, root)
  ) {
    return null;
  }
  return { memory, identity, root };
}

export interface ManagedMemoryDetails {
  format: "memwarden.memory.v1";
  memory: ManagedMemorySummary;
  evidence: {
    files: Array<{ path: string; sha256: string | null }>;
    fileCount: number;
    truncated: boolean;
    userConfirmed: boolean;
    authoredBy?: Provenance["authoredBy"];
    capturedAt?: string;
    agent?: string;
    hasCommand: boolean;
  };
  lifecycle: {
    transitions: Memory["lifecycleTransitions"];
    validityIntervals: ReturnType<typeof validityIntervalsOf>;
    transitionHistoryTruncated: boolean;
  };
  lineage: ManagedMemorySummary["lineage"] & { relatedIds: string[] };
  content?: {
    format: "memwarden.untrusted-data.v1";
    label: ManagementStatus;
    framed: string;
    originalChars: number;
    truncated: boolean;
  };
}

async function detailsFromScoped(
  scoped: { memory: Memory; identity: ResolvedMemoryIdentity; root: string },
  includeContent: boolean,
): Promise<ManagedMemoryDetails> {
  const { memory, identity, root } = scoped;
  const verdict = managementVerdict(memory, identity, root);
  const summary = summaryFrom(memory, identity, verdict);
  const rawFiles = Array.isArray(memory.provenance?.files)
    ? memory.provenance.files
    : Array.isArray(memory.files)
      ? memory.files
      : [];
  const files = boundedMemoryFiles(memory);
  const fileCount = rawFiles.length;
  const hashes = isRecord(memory.provenance?.fileHashes)
    ? memory.provenance.fileHashes
    : {};
  const rawTransitions = Array.isArray(memory.lifecycleTransitions)
    ? memory.lifecycleTransitions
    : [];
  const transitions = rawTransitions
    .slice(0, 100)
    .filter(isValidRecordedLifecycleTransition);
  const authoredBy = memory.provenance?.authoredBy;
  const safeAuthoredBy =
    authoredBy === "user" ||
    authoredBy === "agent" ||
    authoredBy === "user_or_agent"
      ? authoredBy
      : undefined;
  const capturedAt =
    typeof memory.provenance?.capturedAt === "string"
      ? memory.provenance.capturedAt
      : undefined;
  const evidenceAgent =
    typeof memory.provenance?.agent === "string"
      ? memory.provenance.agent
      : undefined;
  return {
    format: "memwarden.memory.v1",
    memory: summary,
    evidence: {
      files: files.map((path) => ({
        path: clipped(path, 1_024),
        sha256:
          typeof hashes[path] === "string" && /^[a-f0-9]{64}$/.test(hashes[path]!)
            ? hashes[path]!
            : null,
      })),
      fileCount,
      truncated: fileCount > files.length,
      userConfirmed: memory.provenance?.userConfirmed === true,
      ...(safeAuthoredBy ? { authoredBy: safeAuthoredBy } : {}),
      ...(capturedAt ? { capturedAt: clipped(capturedAt, 128) } : {}),
      ...(evidenceAgent ? { agent: clipped(evidenceAgent, 256) } : {}),
      hasCommand: Boolean(memory.provenance?.command),
    },
    lifecycle: {
      transitions,
      validityIntervals: validityIntervalsOf(memory),
      transitionHistoryTruncated:
        Array.isArray(memory.lifecycleTransitions) &&
        memory.lifecycleTransitions.length > transitions.length,
    },
    lineage: {
      ...summary.lineage,
      relatedIds: safeIdList(memory.relatedIds),
    },
    ...(includeContent
      ? {
          content: {
            format: "memwarden.untrusted-data.v1" as const,
            label: summary.status,
            framed: frameMemoryInspection(
              memory.content.slice(0, MAX_INSPECTION_CONTENT_CHARS),
            ),
            originalChars: memory.content.length,
            truncated: memory.content.length > MAX_INSPECTION_CONTENT_CHARS,
          },
        }
      : {}),
  };
}

export async function showManagedMemory(
  kv: StateKV,
  input: { id: string; project: string; includeContent?: boolean },
): Promise<ManagedMemoryDetails | null> {
  if (!isRecord(input)) {
    throw new ManagementError("invalid_input", "show input must be an object");
  }
  if (input.includeContent !== undefined && typeof input.includeContent !== "boolean") {
    throw new ManagementError("invalid_input", "includeContent must be a boolean");
  }
  const scoped = await scopedMemory(kv, input.id, input.project);
  return scoped ? detailsFromScoped(scoped, input.includeContent === true) : null;
}

export interface EditManagedMemoryInput {
  id: string;
  project: string;
  title: string;
  text: string;
  kind?: Memory["type"];
  files?: string[];
  noFileEvidence?: boolean;
  authoredBy: "user" | "agent";
  agent?: string;
}

export type EditManagedMemoryResult =
  | {
      ok: true;
      predecessor: ManagedMemorySummary;
      successor: ManagedMemorySummary;
    }
  | { ok: false; code: string; error: string };

export async function editManagedMemory(
  kv: StateKV,
  input: EditManagedMemoryInput,
): Promise<EditManagedMemoryResult> {
  if (!isRecord(input)) {
    return { ok: false, code: "invalid_input", error: "edit input must be an object" };
  }
  const scoped = await scopedMemory(kv, input.id, input.project);
  if (!scoped) return { ok: false, code: "not_found", error: "memory not found in project" };
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 160
  ) {
    return {
      ok: false,
      code: "invalid_input",
      error: "title must be a non-empty string of at most 160 characters",
    };
  }
  if (
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 200_000
  ) {
    return {
      ok: false,
      code: "invalid_input",
      error: "text must be a non-empty string of at most 200000 characters",
    };
  }
  if (!(["user", "agent"] as const).includes(input.authoredBy)) {
    return {
      ok: false,
      code: "invalid_input",
      error: "authoredBy must explicitly be user or agent",
    };
  }
  if (
    input.agent !== undefined &&
    (typeof input.agent !== "string" || !input.agent.trim() || input.agent.length > 256)
  ) {
    return {
      ok: false,
      code: "invalid_input",
      error: "agent must be a non-empty string of at most 256 characters",
    };
  }
  if (input.authoredBy === "agent" && !input.agent?.trim()) {
    return {
      ok: false,
      code: "invalid_input",
      error: "agent is required when authoredBy=agent",
    };
  }
  const hasFiles = input.files !== undefined;
  if (hasFiles === (input.noFileEvidence === true)) {
    return {
      ok: false,
      code: "invalid_input",
      error: "choose exactly one evidence mode: files or noFileEvidence=true",
    };
  }
  if (
    hasFiles &&
    (!Array.isArray(input.files) ||
      input.files.length === 0 ||
      input.files.length > MAX_EVIDENCE_FILES ||
      input.files.some((file) => typeof file !== "string" || !file.trim()))
  ) {
    return {
      ok: false,
      code: "invalid_input",
      error: `files must contain 1 to ${MAX_EVIDENCE_FILES} project-relative paths`,
    };
  }
  if (
    input.kind !== undefined &&
    !(MANUAL_MEMORY_KINDS as readonly string[]).includes(input.kind)
  ) {
    return {
      ok: false,
      code: "invalid_input",
      error: `kind must be one of: ${MANUAL_MEMORY_KINDS.join(", ")}`,
    };
  }

  const remember = await rememberMemory(kv, {
    text: input.text,
    title: input.title.trim(),
    kind: input.kind ?? scoped.memory.type,
    files: hasFiles ? input.files! : [],
    project: scoped.root,
    supersedes: scoped.memory.id,
    authoredBy: input.authoredBy,
    requireNewVersion: true,
    expectedProjectKey:
      scoped.identity.projectKey ?? computeProjectKey(scoped.root),
    ...(input.agent?.trim() ? { agent: input.agent.trim() } : {}),
    ...(scoped.memory.retention === "expires" && scoped.memory.forgetAfter
      ? { expiresAt: scoped.memory.forgetAfter }
      : { expiresAt: null }),
  });
  if (!remember.success || !remember.memory) {
    return {
      ok: false,
      code: "remember_failed",
      error: remember.reason ?? "successor was not saved",
    };
  }
  const predecessor =
    (await kv.get<Memory>(KV.memories, scoped.memory.id).catch(() => null)) ??
    scoped.memory;
  const predecessorVerdict = managementVerdict(predecessor, scoped.identity, scoped.root);
  const successorIdentity = resolveMemoryIdentity(remember.memory);
  const successorVerdict = managementVerdict(
    remember.memory,
    successorIdentity,
    scoped.root,
  );
  return {
    ok: true,
    predecessor: summaryFrom(predecessor, scoped.identity, predecessorVerdict),
    successor: summaryFrom(remember.memory, successorIdentity, successorVerdict),
  };
}

export interface ManagedTransitionInput {
  id: string;
  project: string;
  reason: string;
  actor?: string;
  confirmed?: boolean;
}

export async function archiveManagedMemory(
  kv: StateKV,
  input: ManagedTransitionInput,
): Promise<TransitionMemoryLifecycleResult> {
  if (!isRecord(input)) {
    return { ok: false, code: "invalid_input", error: "archive input must be an object" };
  }
  const scoped = await scopedMemory(kv, input.id, input.project);
  if (!scoped) {
    return { ok: false, code: "not_found", error: "memory not found in project" };
  }
  return transitionMemoryLifecycle(kv, {
    memoryId: scoped.memory.id,
    action: "archive",
    reason: input.reason,
    root: scoped.root,
    requireProjectScope: true,
    expectedProjectKey: scoped.identity.projectKey ?? computeProjectKey(scoped.root),
    ...(input.actor ? { actor: input.actor } : {}),
  });
}

export async function revalidateManagedMemory(
  kv: StateKV,
  input: ManagedTransitionInput,
): Promise<TransitionMemoryLifecycleResult> {
  if (!isRecord(input)) {
    return {
      ok: false,
      code: "invalid_input",
      error: "revalidate input must be an object",
    };
  }
  if (input.confirmed !== true) {
    return {
      ok: false,
      code: "invalid_input",
      error: "revalidation requires deliberate confirmation",
    };
  }
  const scoped = await scopedMemory(kv, input.id, input.project);
  if (!scoped) {
    return { ok: false, code: "not_found", error: "memory not found in project" };
  }
  return transitionMemoryLifecycle(kv, {
    memoryId: scoped.memory.id,
    action: "revalidate",
    reason: input.reason,
    root: scoped.root,
    requireProjectScope: true,
    expectedProjectKey: scoped.identity.projectKey ?? computeProjectKey(scoped.root),
    ...(input.actor ? { actor: input.actor } : {}),
  });
}

export interface ManagedHistoryResult {
  format: "memwarden.memory-history.v1";
  rootId: string;
  project: { path: string; key: string };
  limit: number;
  items: ManagedMemorySummary[];
  cycleDetected: boolean;
  truncated: boolean;
  unresolvedLinks: number;
}

function lineageNeighbors(memory: Memory): string[] {
  const parentId = safeScalarId(memory.parentId);
  const supersededBy = safeScalarId(memory.supersededBy);
  return Array.from(
    new Set([
      ...(parentId ? [parentId] : []),
      ...safeIdList(memory.supersedes),
      ...(supersededBy ? [supersededBy] : []),
    ]),
  )
    .filter((id) => id && id !== memory.id)
    .sort();
}

function directedCycle(memories: Map<string, Memory>): boolean {
  const edges = new Map<string, Set<string>>();
  const add = (from: string, to: string): void => {
    if (!memories.has(from) || !memories.has(to)) return;
    const set = edges.get(from) ?? new Set<string>();
    set.add(to);
    edges.set(from, set);
  };
  for (const memory of memories.values()) {
    const parentId = safeScalarId(memory.parentId);
    const supersededBy = safeScalarId(memory.supersededBy);
    if (parentId) add(parentId, memory.id);
    if (supersededBy) add(memory.id, supersededBy);
    for (const predecessor of safeIdList(memory.supersedes)) add(predecessor, memory.id);
  }
  const colors = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const color = colors.get(id) ?? 0;
    if (color === 1) return true;
    if (color === 2) return false;
    colors.set(id, 1);
    for (const next of edges.get(id) ?? []) {
      if (visit(next)) return true;
    }
    colors.set(id, 2);
    return false;
  };
  for (const id of memories.keys()) if (visit(id)) return true;
  return false;
}

export async function historyManagedMemory(
  kv: StateKV,
  input: { id: string; project: string; limit?: number },
): Promise<ManagedHistoryResult | null> {
  if (!isRecord(input)) {
    throw new ManagementError("invalid_input", "history input must be an object");
  }
  const limit = normalizedLimit(
    input.limit,
    MEMORY_HISTORY_DEFAULT_LIMIT,
    MEMORY_HISTORY_MAX_LIMIT,
  );
  const context: IdentityContext = { sessions: new Map() };
  const start = await scopedMemory(kv, input.id, input.project, context);
  if (!start) return null;
  const queue = [start.memory.id];
  const queued = new Set(queue);
  const memories = new Map<string, Memory>();
  const identities = new Map<string, ResolvedMemoryIdentity>();
  let unresolvedLinks = 0;

  while (queue.length > 0 && memories.size < limit) {
    const id = queue.shift()!;
    const scoped =
      id === start.memory.id
        ? start
        : await scopedMemory(kv, id, start.root, context);
    if (!scoped) {
      unresolvedLinks++;
      continue;
    }
    memories.set(id, scoped.memory);
    identities.set(id, scoped.identity);
    for (const neighbor of lineageNeighbors(scoped.memory)) {
      if (!queued.has(neighbor) && !memories.has(neighbor)) {
        queued.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  const summaries: ManagedMemorySummary[] = [];
  for (const memory of memories.values()) {
    const identity = identities.get(memory.id)!;
    summaries.push(
      summaryFrom(memory, identity, managementVerdict(memory, identity, start.root)),
    );
  }
  summaries.sort((left, right) => {
    if (left.version !== right.version) return left.version - right.version;
    const byCreated = left.createdAt.localeCompare(right.createdAt);
    return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
  });
  return {
    format: "memwarden.memory-history.v1",
    rootId: start.memory.id,
    project: {
      path: start.root,
      key: clipped(computeProjectKey(start.root), 4_096),
    },
    limit,
    items: summaries,
    cycleDetected: directedCycle(memories),
    truncated: queue.length > 0,
    unresolvedLinks,
  };
}

type CountMap<K extends string> = Record<K, number>;

function zeroCounts<K extends string>(keys: readonly K[]): CountMap<K> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as CountMap<K>;
}

export interface ProjectAggregate {
  path: string | null;
  key: string | null;
  pathCount: number;
  counts: {
    memories: number;
    evidence: CountMap<EvidenceTrust>;
    source: CountMap<LiveSourceStatus>;
    status: CountMap<ManagementStatus>;
    lifecycle: CountMap<MemoryLifecycleState>;
  };
  lastActivity: string | null;
  footprint: { records: number; estimatedBytes: number };
}

export interface ProjectListPage {
  format: "memwarden.projects.v1";
  order: "project-identity-ascending";
  snapshotAt: string;
  limit: number;
  projects: ProjectAggregate[];
  totalProjects: number;
  totalMemories: number;
  scannedMemories: number;
  nextCursor: string | null;
}

interface MutableProjectAggregate extends ProjectAggregate {
  sortKey: string;
  paths: Set<string>;
  lastActivityMs: number;
}

function projectSortKey(prefix: "key" | "path", value: string): string {
  return value.length <= 1_024
    ? `${prefix}:${value}`
    : `${prefix}:sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function emptyProject(sortKey: string, identity: ResolvedMemoryIdentity): MutableProjectAggregate {
  const path = identity.projectPath ?? identity.captureCwd;
  return {
    sortKey,
    path: path ? clipped(path, 4_096) : null,
    key: identity.projectKey ? clipped(identity.projectKey, 4_096) : null,
    pathCount: 0,
    paths: new Set<string>(),
    counts: {
      memories: 0,
      evidence: zeroCounts(["verified", "sourced", "unsourced"] as const),
      source: zeroCounts(
        ["matched", "cosmetic_drift", "drifted", "missing", "unknown"] as const,
      ),
      status: zeroCounts(
        [
          "verified",
          "cosmetic",
          "sourced_unverified",
          "stale",
          "unsourced",
          "unverifiable",
        ] as const,
      ),
      lifecycle: zeroCounts(MEMORY_LIFECYCLE_STATES),
    },
    lastActivity: null,
    lastActivityMs: -Infinity,
    footprint: { records: 0, estimatedBytes: 0 },
  };
}

export async function listManagedProjects(
  kv: StateKV,
  input: { limit?: number; cursor?: string },
): Promise<ProjectListPage> {
  if (!isRecord(input)) {
    throw new ManagementError("invalid_input", "projects input must be an object");
  }
  const limit = normalizedLimit(
    input.limit,
    PROJECT_LIST_DEFAULT_LIMIT,
    PROJECT_LIST_MAX_LIMIT,
  );
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== "string" ||
      !input.cursor ||
      input.cursor.length > MAX_CURSOR_CHARS)
  ) {
    throw new ManagementError("invalid_cursor", "cursor has an invalid shape");
  }
  const descriptor = { resource: "projects", version: 1 };
  const expectedHash = filterHash(descriptor);
  const decoded = input.cursor
    ? await decodeCursor(kv, input.cursor, "projects", expectedHash)
    : null;
  const snapshotAt = decoded?.snapshotAt ?? new Date().toISOString();
  const snapshotMs = Date.parse(snapshotAt);
  const aggregates = new Map<string, MutableProjectAggregate>();
  const context: IdentityContext = { sessions: new Map() };
  let after: string | undefined;
  let scanned = 0;
  let storeHasMore = false;

  do {
    const page = await kv.listPage<Memory>(KV.memories, {
      ...(after ? { after } : {}),
      limit: Math.min(STORAGE_PAGE, PROJECT_MEMORY_SCAN_CAP - scanned),
    });
    storeHasMore = page.hasMore;
    for (const entry of page.entries) {
      after = entry.key;
      scanned++;
      const memory = entry.value;
      if (!isMemoryRecord(memory) || createdAfterSnapshot(memory, snapshotMs)) continue;
      const identity = await resolveIdentityBounded(kv, memory, context);
      const identityPath = identity.projectPath ?? identity.captureCwd;
      const sortKey = identity.projectKey
        ? projectSortKey("key", identity.projectKey)
        : identityPath
          ? projectSortKey("path", canonicalizePath(identityPath))
          : "unscoped";
      let aggregate = aggregates.get(sortKey);
      if (!aggregate) {
        aggregate = emptyProject(sortKey, identity);
        aggregates.set(sortKey, aggregate);
      }
      for (const path of [identity.projectPath, identity.captureCwd]) {
        if (path) aggregate.paths.add(clipped(path, 4_096));
      }
      aggregate.pathCount = aggregate.paths.size;
      const verdict = managementVerdict(memory, identity);
      const summary = summaryFrom(memory, identity, verdict);
      aggregate.counts.memories++;
      aggregate.counts.evidence[summary.evidence.trust]++;
      aggregate.counts.source[summary.source.status]++;
      aggregate.counts.status[summary.status]++;
      aggregate.counts.lifecycle[summary.lifecycle.persisted]++;
      aggregate.footprint.records++;
      try {
        aggregate.footprint.estimatedBytes += Buffer.byteLength(JSON.stringify(memory));
      } catch {
        // A malformed/non-serializable legacy value was already shape-checked;
        // omit only its byte estimate rather than its count.
      }
      const activity = activityTime(memory);
      if (activity !== null && activity > aggregate.lastActivityMs) {
        aggregate.lastActivityMs = activity;
        aggregate.lastActivity = new Date(activity).toISOString();
        const activePath = identity.projectPath ?? identity.captureCwd;
        aggregate.path = activePath ? clipped(activePath, 4_096) : aggregate.path;
      }
    }
    if (!page.hasMore) break;
  } while (scanned < PROJECT_MEMORY_SCAN_CAP);

  if (storeHasMore && scanned >= PROJECT_MEMORY_SCAN_CAP) {
    throw new ManagementError(
      "scan_limit",
      `project aggregation exceeds the bounded ${PROJECT_MEMORY_SCAN_CAP}-memory scan cap`,
    );
  }

  const all = [...aggregates.values()].sort((a, b) =>
    compareCursorKeys(a.sortKey, b.sortKey),
  );
  const afterProject = decoded?.after;
  const remaining = afterProject
    ? all.filter((aggregate) => compareCursorKeys(aggregate.sortKey, afterProject) > 0)
    : all;
  const selected = remaining.slice(0, limit);
  const hasMoreProjects = remaining.length > selected.length;
  const nextCursor =
    hasMoreProjects && selected.length > 0
      ? await encodeCursor(kv, {
          v: CURSOR_VERSION,
          resource: "projects",
          filterHash: expectedHash,
          snapshotAt,
          after: selected[selected.length - 1]!.sortKey,
        })
      : null;
  const projects = selected.map(({ sortKey: _sortKey, paths: _paths, lastActivityMs: _ms, ...project }) => project);
  return {
    format: "memwarden.projects.v1",
    order: "project-identity-ascending",
    snapshotAt,
    limit,
    projects,
    totalProjects: all.length,
    totalMemories: all.reduce((total, project) => total + project.counts.memories, 0),
    scannedMemories: scanned,
    nextCursor,
  };
}

export function registerManagementFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::memories-list", (input: ListManagedMemoriesInput) =>
    listManagedMemories(kv, input),
  );
  sdk.registerFunction(
    "mem::memory-show",
    (input: { id: string; project: string; includeContent?: boolean }) =>
      showManagedMemory(kv, input),
  );
  sdk.registerFunction("mem::memory-edit", (input: EditManagedMemoryInput) =>
    editManagedMemory(kv, input),
  );
  sdk.registerFunction("mem::memory-archive", (input: ManagedTransitionInput) =>
    archiveManagedMemory(kv, input),
  );
  sdk.registerFunction("mem::memory-revalidate", (input: ManagedTransitionInput) =>
    revalidateManagedMemory(kv, input),
  );
  sdk.registerFunction(
    "mem::memory-history",
    (input: { id: string; project: string; limit?: number }) =>
      historyManagedMemory(kv, input),
  );
  sdk.registerFunction(
    "mem::projects",
    (input: { limit?: number; cursor?: string }) => listManagedProjects(kv, input),
  );
}

export function managementHttpStatus(error: unknown): number {
  if (error instanceof ManagementError) {
    if (error.code === "not_found") return 404;
    if (error.code === "project_mismatch" || error.code === "transition_failed") {
      return 409;
    }
    if (error.code === "scan_limit") return 413;
    return 400;
  }
  return 500;
}

export function transitionStatus(result: TransitionMemoryLifecycleResult): number {
  if (result.ok) return 200;
  if (result.code === "not_found") return 404;
  if (result.code === "invalid_input") return 400;
  if (result.code === "write_failed") return 500;
  return 409;
}
