//
// Explicit Memory lifecycle transitions. This is the only semantic lifecycle
// write boundary: recall/doctor/why derive effective needs_revalidation from
// live source drift without writing during a read.
//

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type {
  Memory,
  MemoryLifecycleAction,
  MemoryLifecycleState,
  MemoryLifecycleTransition,
} from "./types.js";
import {
  applyMemoryLifecycleTransition,
  initializeMemoryLifecycle,
  isMemoryLifecycleState,
  lifecycleProjection,
  MEMORY_LIFECYCLE_ACTIONS,
  persistedLifecycleOf,
} from "./memory-lifecycle.js";
import { canonicalizePath } from "./paths.js";
import { projectKey as computeProjectKey } from "./git-identity.js";
import {
  hasProjectIdentity,
  projectIdentityMatchesPath,
  resolveMemoryIdentity,
  type ProjectIdentity,
} from "./memory-identity.js";
import {
  classifyProvenance,
  hashFileCommitments,
  type FileHashCommitments,
  type LiveSourceStatus,
} from "./verify.js";
import { isMemoryRecallable, memoryToObservation } from "./memory-utils.js";
import {
  getSearchIndex,
  vectorIndexAddGuarded,
  vectorIndexRemove,
} from "./search.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { fineGrainedClaimForMemory } from "./anchors.js";

export interface TransitionMemoryLifecycleInput {
  memoryId: string;
  action: Exclude<MemoryLifecycleAction, "create">;
  reason: string;
  actor?: string;
  at?: string;
  root?: string;
  successorId?: string;
}

export type TransitionMemoryLifecycleResult =
  | {
      ok: true;
      memory: Memory;
      previous: Memory;
      successor?: Memory;
      effectiveLifecycle: MemoryLifecycleState;
      sourceStatus?: LiveSourceStatus;
    }
  | {
      ok: false;
      code:
        | "invalid_input"
        | "not_found"
        | "invalid_transition"
        | "project_mismatch"
        | "source_unavailable"
        | "write_failed";
      error: string;
      memoryId?: string;
    };

function cleanTimestamp(value: string | undefined): string {
  const at = value?.trim() || new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error("at must be a valid date-time string");
  }
  return at;
}

function existingDirectory(path: string | undefined): string | null {
  if (!path || !isAbsolute(path)) return null;
  const root = canonicalizePath(path);
  try {
    return statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

function reRootEvidenceFiles(memory: Memory): string[] {
  const files = memory.provenance?.files ?? memory.files;
  const captureRoot = memory.provenance?.cwd;
  if (!captureRoot || !isAbsolute(captureRoot)) return [...files];
  return files.map((file) => {
    if (!isAbsolute(file)) return file;
    const fromCapture = relative(captureRoot, file);
    if (
      !fromCapture ||
      fromCapture === ".." ||
      fromCapture.startsWith(`..${sep}`) ||
      isAbsolute(fromCapture)
    ) {
      return file;
    }
    return fromCapture.split(sep).join("/");
  });
}

function identityKey(identity: ProjectIdentity): string | undefined {
  return identity.projectKey ?? identity.projectPath ?? identity.captureCwd;
}

function sameMemoryProject(left: Memory, right: Memory): boolean {
  const a = resolveMemoryIdentity(left);
  const b = resolveMemoryIdentity(right);
  if (a.projectKey && b.projectKey) return a.projectKey === b.projectKey;
  const aKey = identityKey(a);
  const bKey = identityKey(b);
  return Boolean(aKey && bKey && canonicalizePath(aKey) === canonicalizePath(bKey));
}

function effectiveLifecycleAtRoot(
  memory: Memory,
  root: string | undefined,
): { effective: MemoryLifecycleState; sourceStatus?: LiveSourceStatus } {
  const persisted = persistedLifecycleOf(memory);
  if (persisted !== "active") return { effective: persisted };
  const checkout = existingDirectory(root);
  if (!checkout) return { effective: persisted };
  const identity = resolveMemoryIdentity(memory);
  if (
    hasProjectIdentity(identity) &&
    !projectIdentityMatchesPath(identity, checkout)
  ) {
    return { effective: persisted };
  }
  const observation = memoryToObservation(memory, identity);
  const verdict = classifyProvenance(observation.provenance, checkout, {
    verifyAgainstRoot: true,
    fineGrainedClaim: fineGrainedClaimForMemory(memory),
  });
  return {
    effective: lifecycleProjection(
      memory,
      verdict.sourceStatus,
      verdict.evidenceTrust === "verified" && verdict.sourceStatus === "unknown",
    ).effective,
    sourceStatus: verdict.sourceStatus,
  };
}

async function syncMemoryIndex(memory: Memory): Promise<void> {
  const index = getSearchIndex();
  index.remove(memory.id);
  vectorIndexRemove(memory.id);
  if (!isMemoryRecallable(memory)) return;
  const observation = memoryToObservation(memory);
  index.add(observation);
  await vectorIndexAddGuarded(
    memory.id,
    observation.sessionId,
    `${memory.title} ${memory.content}`,
    { kind: "memory", logId: memory.id },
  );
}

function validationFailureCode(
  message: string,
): "invalid_input" | "invalid_transition" {
  return /^(reason|actor|at)\b/.test(message) ||
    message.startsWith("unsupported lifecycle action")
    ? "invalid_input"
    : "invalid_transition";
}

function transitionFailure(
  code: Extract<TransitionMemoryLifecycleResult, { ok: false }>["code"],
  error: string,
  memoryId?: string,
): TransitionMemoryLifecycleResult {
  return { ok: false, code, error, ...(memoryId ? { memoryId } : {}) };
}

function stripVersionLifecycle(memory: Memory): Omit<
  Memory,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "validFrom"
  | "validTo"
  | "validityIntervals"
  | "lifecycle"
  | "lifecycleReason"
  | "lifecycleChangedAt"
  | "lifecycleTransitions"
  | "lifecycleMigratedFromLegacy"
  | "supersededBy"
  | "evidenceFingerprint"
  | "sourceCommit"
  | "sourceObservationIds"
> {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    validFrom: _validFrom,
    validTo: _validTo,
    validityIntervals: _validityIntervals,
    lifecycle: _lifecycle,
    lifecycleReason: _lifecycleReason,
    lifecycleChangedAt: _lifecycleChangedAt,
    lifecycleTransitions: _lifecycleTransitions,
    lifecycleMigratedFromLegacy: _lifecycleMigratedFromLegacy,
    supersededBy: _supersededBy,
    evidenceFingerprint: _evidenceFingerprint,
    sourceCommit: _sourceCommit,
    sourceObservationIds: _sourceObservationIds,
    ...rest
  } = memory;
  return rest;
}

function revalidatedSuccessor(args: {
  memory: Memory;
  root: string;
  at: string;
  reason: string;
  actor?: string;
  files: string[];
  commitments: FileHashCommitments;
}): Memory {
  const { memory, root, at, reason, actor, files, commitments } = args;
  const sortedRaw = Object.entries(commitments.fileHashes).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const sortedNormalized = Object.entries(
    commitments.fileHashesNormalized,
  ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "revalidation",
        memory.id,
        at,
        sortedRaw,
        sortedNormalized,
      ]),
    )
    .digest("hex");
  const id = `mem_revalidation_${digest}`;
  const base = stripVersionLifecycle(memory);
  const lifecycle = initializeMemoryLifecycle(at, reason, actor);
  const revalidationTransition: MemoryLifecycleTransition = {
    from: "needs_revalidation",
    to: "active",
    action: "revalidate",
    at,
    reason,
    ...(actor ? { actor } : {}),
  };
  // The predecessor keeps any Canon attestation. A local revalidation creates
  // fresh source evidence, not a new Canon promotion/reanchor, so copying the
  // attestation onto the successor would overstate what reviewers attested.
  const {
    canon: _priorCanon,
    fileHashesNormalized: _priorNormalizedHashes,
    anchors: _priorAnchors,
    ...priorProvenance
  } = memory.provenance ?? {};
  const provenance = {
    ...priorProvenance,
    cwd: root,
    files: [...files],
    fileHashes: { ...commitments.fileHashes },
    ...(Object.keys(commitments.fileHashesNormalized).length > 0
      ? {
          fileHashesNormalized: {
            ...commitments.fileHashesNormalized,
          },
        }
      : {}),
    capturedAt: at,
    userConfirmed: true,
  };
  return {
    ...base,
    id,
    createdAt: at,
    updatedAt: at,
    version: memory.version + 1,
    files: [...files],
    parentId: memory.parentId ?? memory.id,
    supersedes: Array.from(new Set([...(memory.supersedes ?? []), memory.id])),
    isLatest: true,
    projectPath: root,
    projectKey: computeProjectKey(root),
    captureCwd: root,
    provenance,
    ...lifecycle,
    lifecycleTransitions: [revalidationTransition],
  };
}

async function revalidateMemory(
  kv: StateKV,
  memory: Memory,
  input: TransitionMemoryLifecycleInput,
  at: string,
): Promise<TransitionMemoryLifecycleResult> {
  const root = existingDirectory(input.root);
  if (!root) {
    return transitionFailure(
      "source_unavailable",
      "revalidate requires root to be an existing absolute project directory",
      memory.id,
    );
  }
  const identity = resolveMemoryIdentity(memory);
  if (
    hasProjectIdentity(identity) &&
    !projectIdentityMatchesPath(identity, root)
  ) {
    return transitionFailure(
      "project_mismatch",
      "root does not match the memory's project identity",
      memory.id,
    );
  }
  const provenance = memory.provenance;
  const files = provenance?.files ?? memory.files;
  if (files.length === 0) {
    return transitionFailure(
      "source_unavailable",
      "revalidation requires file evidence; command-only and unsourced memories must be restored or superseded explicitly",
      memory.id,
    );
  }
  const verdict = classifyProvenance(
    provenance ?? { files, command: "memory" },
    root,
    {
      verifyAgainstRoot: true,
      fineGrainedClaim: fineGrainedClaimForMemory(memory),
    },
  );
  const projection = lifecycleProjection(
    memory,
    verdict.sourceStatus,
    false,
  );
  if (
    persistedLifecycleOf(memory) !== "needs_revalidation" &&
    projection.effective !== "needs_revalidation"
  ) {
    return transitionFailure(
      "invalid_transition",
      "revalidate is only valid for needs_revalidation memory",
      memory.id,
    );
  }
  const filesAtRoot = reRootEvidenceFiles(memory);
  const commitments = hashFileCommitments(filesAtRoot, root);
  if (filesAtRoot.some((file) => !commitments.fileHashes[file])) {
    return transitionFailure(
      "source_unavailable",
      "every referenced source file must exist and be hashable before revalidation",
      memory.id,
    );
  }

  const existingCommitmentsStillCurrent =
    verdict.status === "verified" || verdict.status === "cosmetic";
  if (
    existingCommitmentsStillCurrent &&
    persistedLifecycleOf(memory) === "needs_revalidation"
  ) {
    let restored: Memory;
    try {
      restored = applyMemoryLifecycleTransition(memory, {
        action: "revalidate",
        reason: input.reason,
        at,
        ...(input.actor ? { actor: input.actor } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return transitionFailure(
        validationFailureCode(message),
        message,
        memory.id,
      );
    }
    try {
      await kv.set(KV.memories, restored.id, restored);
      await syncMemoryIndex(restored);
    } catch (err) {
      return transitionFailure(
        "write_failed",
        err instanceof Error ? err.message : String(err),
        memory.id,
      );
    }
    return {
      ok: true,
      memory: restored,
      previous: memory,
      effectiveLifecycle: "active",
      sourceStatus: verdict.sourceStatus,
    };
  }

  // Changed capture commitments define a new content/evidence version. Keep the
  // old row, close its interval, and install a linked successor rather than
  // overwriting history or claiming oplog hashes can reconstruct it later.
  const successor = revalidatedSuccessor({
    memory,
    root,
    at,
    reason: input.reason,
    ...(input.actor ? { actor: input.actor } : {}),
    files: filesAtRoot,
    commitments,
  });
  let superseded: Memory;
  try {
    superseded = applyMemoryLifecycleTransition(memory, {
      action: "supersede",
      reason: input.reason,
      at,
      ...(input.actor ? { actor: input.actor } : {}),
      supersededBy: successor.id,
    });
  } catch (err) {
    return transitionFailure(
      "invalid_transition",
      err instanceof Error ? err.message : String(err),
      memory.id,
    );
  }

  let existingSuccessor: Memory | null;
  try {
    existingSuccessor = await kv.get<Memory>(KV.memories, successor.id);
  } catch (err) {
    return transitionFailure(
      "write_failed",
      `could not inspect revalidation successor slot: ${err instanceof Error ? err.message : String(err)}`,
      memory.id,
    );
  }
  if (existingSuccessor) {
    return transitionFailure(
      "invalid_transition",
      `revalidation successor slot ${successor.id} is already occupied; no record was overwritten`,
      memory.id,
    );
  }
  try {
    // Close the predecessor first so a concurrent current read sees a safe gap,
    // never two simultaneously-current versions. Roll back both slots below if
    // successor installation fails.
    await kv.set(KV.memories, superseded.id, superseded);
    await kv.set(KV.memories, successor.id, successor);
  } catch (err) {
    await kv.delete(KV.memories, successor.id).catch(() => undefined);
    await kv.set(KV.memories, memory.id, memory).catch(() => undefined);
    return transitionFailure(
      "write_failed",
      err instanceof Error ? err.message : String(err),
      memory.id,
    );
  }
  await syncMemoryIndex(superseded);
  await syncMemoryIndex(successor);
  return {
    ok: true,
    memory: superseded,
    previous: memory,
    successor,
    effectiveLifecycle: "active",
    sourceStatus: "matched",
  };
}

export async function transitionMemoryLifecycle(
  kv: StateKV,
  input: TransitionMemoryLifecycleInput,
): Promise<TransitionMemoryLifecycleResult> {
  if (typeof input?.memoryId !== "string" || !input.memoryId.trim()) {
    return transitionFailure("invalid_input", "memoryId is required");
  }
  if (input.memoryId.length > 512) {
    return transitionFailure(
      "invalid_input",
      "memoryId must be at most 512 characters",
    );
  }
  if (
    input.root !== undefined &&
    (typeof input.root !== "string" || input.root.length > 4_096)
  ) {
    return transitionFailure(
      "invalid_input",
      "root must be a string of at most 4096 characters",
      input.memoryId,
    );
  }
  if (
    input.successorId !== undefined &&
    (typeof input.successorId !== "string" || input.successorId.length > 512)
  ) {
    return transitionFailure(
      "invalid_input",
      "successorId must be a string of at most 512 characters",
      input.memoryId,
    );
  }
  if (
    typeof input.action !== "string" ||
    !MEMORY_LIFECYCLE_ACTIONS.includes(
      input.action as (typeof MEMORY_LIFECYCLE_ACTIONS)[number],
    )
  ) {
    return transitionFailure(
      "invalid_input",
      `action must be one of: ${MEMORY_LIFECYCLE_ACTIONS.join(", ")}`,
      input.memoryId,
    );
  }
  let at: string;
  try {
    at = cleanTimestamp(input.at);
  } catch (err) {
    return transitionFailure(
      "invalid_input",
      err instanceof Error ? err.message : String(err),
      input.memoryId,
    );
  }

  const initial = await kv
    .get<Memory>(KV.memories, input.memoryId.trim())
    .catch(() => null);
  if (!initial) {
    return transitionFailure(
      "not_found",
      `no Memory with id ${input.memoryId.trim()}`,
      input.memoryId.trim(),
    );
  }
  const identity = resolveMemoryIdentity(initial);
  const lockIdentity = identityKey(identity) ?? initial.id;
  return withKeyedLock(`remember:${lockIdentity}`, async () => {
    const memory = await kv
      .get<Memory>(KV.memories, initial.id)
      .catch(() => null);
    if (!memory) {
      return transitionFailure("not_found", `no Memory with id ${initial.id}`, initial.id);
    }

    if (input.action === "revalidate") {
      return revalidateMemory(kv, memory, input, at);
    }

    if (input.action === "supersede") {
      const successorId = input.successorId?.trim();
      if (!successorId) {
        return transitionFailure(
          "invalid_input",
          "successorId is required for supersede",
          memory.id,
        );
      }
      const successor = await kv
        .get<Memory>(KV.memories, successorId)
        .catch(() => null);
      if (!successor) {
        return transitionFailure(
          "not_found",
          `no successor Memory with id ${successorId}`,
          memory.id,
        );
      }
      if (!sameMemoryProject(memory, successor)) {
        return transitionFailure(
          "project_mismatch",
          "successor must belong to the same project",
          memory.id,
        );
      }
      if (persistedLifecycleOf(successor) !== "active") {
        return transitionFailure(
          "invalid_transition",
          "successor must be an active Memory version",
          memory.id,
        );
      }
      let transitioned: Memory;
      try {
        transitioned = applyMemoryLifecycleTransition(memory, {
          action: "supersede",
          reason: input.reason,
          at,
          ...(input.actor ? { actor: input.actor } : {}),
          supersededBy: successor.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return transitionFailure(
          validationFailureCode(message),
          message,
          memory.id,
        );
      }
      const linkedSuccessor: Memory = {
        ...successor,
        updatedAt: at,
        version: Math.max(successor.version, memory.version + 1),
        parentId: successor.parentId ?? memory.parentId ?? memory.id,
        supersedes: Array.from(
          new Set([...(successor.supersedes ?? []), memory.id]),
        ),
      };
      try {
        await kv.set(KV.memories, transitioned.id, transitioned);
        try {
          await kv.set(KV.memories, linkedSuccessor.id, linkedSuccessor);
        } catch (err) {
          await kv.set(KV.memories, memory.id, memory).catch(() => undefined);
          throw err;
        }
      } catch (err) {
        return transitionFailure(
          "write_failed",
          err instanceof Error ? err.message : String(err),
          memory.id,
        );
      }
      await syncMemoryIndex(transitioned);
      await syncMemoryIndex(linkedSuccessor);
      const effective = effectiveLifecycleAtRoot(linkedSuccessor, input.root);
      return {
        ok: true,
        memory: transitioned,
        previous: memory,
        successor: linkedSuccessor,
        effectiveLifecycle: effective.effective,
        ...(effective.sourceStatus
          ? { sourceStatus: effective.sourceStatus }
          : {}),
      };
    }

    let transitioned: Memory;
    try {
      transitioned = applyMemoryLifecycleTransition(memory, {
        action: input.action,
        reason: input.reason,
        at,
        ...(input.actor ? { actor: input.actor } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return transitionFailure(
        validationFailureCode(message),
        message,
        memory.id,
      );
    }
    try {
      await kv.set(KV.memories, transitioned.id, transitioned);
      await syncMemoryIndex(transitioned);
    } catch (err) {
      return transitionFailure(
        "write_failed",
        err instanceof Error ? err.message : String(err),
        memory.id,
      );
    }
    const effective = effectiveLifecycleAtRoot(transitioned, input.root);
    return {
      ok: true,
      memory: transitioned,
      previous: memory,
      effectiveLifecycle: effective.effective,
      ...(effective.sourceStatus
        ? { sourceStatus: effective.sourceStatus }
        : {}),
    };
  });
}

export function registerLifecycleFunction(sdk: ISdk, kv: StateKV): void {
  const handler = (input: TransitionMemoryLifecycleInput) =>
    transitionMemoryLifecycle(kv, input);
  sdk.registerFunction("mem::lifecycle-transition", handler);
  // Concise in-process alias; the explicit id remains the API's canonical one.
  sdk.registerFunction("mem::lifecycle", handler);
}

export { isMemoryLifecycleState };
