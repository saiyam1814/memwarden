//
// Pure Memory lifecycle model. Evidence quality and live source freshness are
// inputs to an effective projection; they are never persisted as semantic
// lifecycle transitions during recall. This keeps reads side-effect free while
// retaining explicit, auditable user decisions and validity intervals.
//

import type {
  Memory,
  MemoryLifecycleAction,
  MemoryLifecycleState,
  MemoryLifecycleTransition,
  MemoryValidityInterval,
} from "./types.js";

export const MEMORY_LIFECYCLE_STATES = [
  "active",
  "needs_revalidation",
  "superseded",
  "disputed",
  "archived",
  "revoked",
] as const satisfies readonly MemoryLifecycleState[];

export const MEMORY_LIFECYCLE_ACTIONS = [
  "mark_needs_revalidation",
  "supersede",
  "dispute",
  "archive",
  "revoke",
  "restore",
  "revalidate",
] as const satisfies readonly Exclude<MemoryLifecycleAction, "create">[];

export const MAX_LIFECYCLE_TRANSITIONS = 100;
export const MAX_LIFECYCLE_REASON_CHARS = 1_000;
export const MAX_LIFECYCLE_ACTOR_CHARS = 256;

const STATES = new Set<string>(MEMORY_LIFECYCLE_STATES);

export function isMemoryLifecycleState(
  value: unknown,
): value is MemoryLifecycleState {
  return typeof value === "string" && STATES.has(value);
}

function parseTime(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validIso(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim() || parseTime(value) === null) {
    throw new Error(`${field} must be a valid date-time string`);
  }
  return value.trim();
}

/** The stored state, with a conservative compatibility interpretation for rows
 * written before lifecycle fields existed. No persistence happens here. */
export function persistedLifecycleOf(memory: Memory): MemoryLifecycleState {
  // Existing lineage markers are stronger than an inconsistent additive field:
  // fail closed rather than reviving an old version that says isLatest=false.
  if (memory.isLatest === false || Boolean(memory.supersededBy)) {
    return "superseded";
  }
  if (
    !lifecycleHistoryIsValid(memory) ||
    (memory.validityIntervals !== undefined &&
      (!Array.isArray(memory.validityIntervals) ||
        (memory.validityIntervals.length > 0 &&
          validStoredIntervals(memory.validityIntervals) === null)))
  ) {
    return "needs_revalidation";
  }
  if (isMemoryLifecycleState(memory.lifecycle)) return memory.lifecycle;
  if (memory.lifecycle !== undefined) return "needs_revalidation";

  const legacy = memory as Memory & {
    lifecycleState?: unknown;
    state?: unknown;
    status?: unknown;
  };
  if (isMemoryLifecycleState(legacy.lifecycleState)) {
    return legacy.lifecycleState;
  }
  if (legacy.lifecycleState !== undefined) return "needs_revalidation";
  if (isMemoryLifecycleState(legacy.state)) return legacy.state;
  if (legacy.state !== undefined) return "needs_revalidation";
  // A few pre-release/imported records carried the old overloaded trust word.
  // Preserve its safe semantic projection without treating it as evidence that
  // a transition was explicitly recorded.
  if (legacy.status === "stale") return "needs_revalidation";
  return "active";
}

export function persistedLifecycleReason(memory: Memory): string {
  if (!lifecycleHistoryIsValid(memory)) {
    return "invalid persisted lifecycle transition history requires revalidation";
  }
  if (
    memory.validityIntervals !== undefined &&
    (!Array.isArray(memory.validityIntervals) ||
      (memory.validityIntervals.length > 0 &&
        validStoredIntervals(memory.validityIntervals) === null))
  ) {
    return "invalid persisted validity interval history requires revalidation";
  }
  if (typeof memory.lifecycleReason === "string" && memory.lifecycleReason.trim()) {
    return memory.lifecycleReason;
  }
  const state = persistedLifecycleOf(memory);
  const legacy = memory as Memory & {
    lifecycleState?: unknown;
    state?: unknown;
    status?: unknown;
  };
  if (
    (memory.lifecycle !== undefined &&
      !isMemoryLifecycleState(memory.lifecycle)) ||
    (legacy.lifecycleState !== undefined &&
      !isMemoryLifecycleState(legacy.lifecycleState)) ||
    (legacy.state !== undefined && !isMemoryLifecycleState(legacy.state))
  ) {
    return "invalid persisted lifecycle metadata requires revalidation";
  }
  if (memory.isLatest === false || memory.supersededBy) {
    return memory.supersededBy
      ? `legacy lineage marks this version superseded by ${memory.supersededBy}`
      : "legacy isLatest=false marks this version superseded";
  }
  if (state === "needs_revalidation") {
    return "legacy stale state requires revalidation";
  }
  return "legacy record defaults to active (no persisted lifecycle metadata)";
}

function initialValidFrom(memory: Memory): string | null {
  for (const value of [
    memory.validFrom,
    memory.observedAt,
    memory.provenance?.capturedAt,
    memory.createdAt,
  ]) {
    if (parseTime(value) !== null) return value!;
  }
  return null;
}

function inferredValidTo(memory: Memory): string | undefined {
  if (parseTime(memory.validTo) !== null) return memory.validTo;
  if (persistedLifecycleOf(memory) === "active") return undefined;
  if (parseTime(memory.lifecycleChangedAt) !== null) {
    return memory.lifecycleChangedAt;
  }
  if (parseTime(memory.updatedAt) !== null) return memory.updatedAt;
  return undefined;
}

function validStoredIntervals(
  intervals: MemoryValidityInterval[] | undefined,
): MemoryValidityInterval[] | null {
  if (
    !Array.isArray(intervals) ||
    intervals.length === 0 ||
    intervals.length > MAX_LIFECYCLE_TRANSITIONS
  ) {
    return null;
  }
  const out: MemoryValidityInterval[] = [];
  let previousFrom = -Infinity;
  let previousTo = -Infinity;
  for (const interval of intervals) {
    const from = parseTime(interval?.validFrom);
    const to = parseTime(interval?.validTo);
    if (
      typeof interval?.validFrom !== "string" ||
      interval.validFrom.length > 128 ||
      from === null ||
      (interval.validTo !== undefined &&
        (typeof interval.validTo !== "string" ||
          interval.validTo.length > 128 ||
          to === null)) ||
      (to !== null && to < from) ||
      from < previousFrom ||
      from < previousTo ||
      (interval.reason !== undefined &&
        (typeof interval.reason !== "string" ||
          interval.reason.length > MAX_LIFECYCLE_REASON_CHARS)) ||
      (interval.inferred !== undefined && interval.inferred !== true)
    ) {
      return null;
    }
    previousFrom = from;
    previousTo = to ?? Infinity;
    out.push({
      validFrom: interval.validFrom,
      ...(interval.validTo ? { validTo: interval.validTo } : {}),
      ...(interval.reason ? { reason: interval.reason } : {}),
      ...(interval.inferred === true ? { inferred: true as const } : {}),
    });
  }
  return out;
}

/** Returns the record's explicit intervals, or one visibly inferred legacy
 * interval. An empty result means even a bounded reconstruction would be
 * dishonest (for example, an invalid/missing capture timestamp). */
export function validityIntervalsOf(memory: Memory): MemoryValidityInterval[] {
  const stored = validStoredIntervals(memory.validityIntervals);
  if (stored) return stored;
  // An explicitly present but malformed interval history is not equivalent to
  // legacy absence. Fail reconstruction rather than replacing bad history with
  // a convenient inferred interval.
  if (
    Array.isArray(memory.validityIntervals) &&
    memory.validityIntervals.length > 0
  ) {
    return [];
  }
  const validFrom = initialValidFrom(memory);
  if (!validFrom) return [];
  const validTo = inferredValidTo(memory);
  return [
    {
      validFrom,
      ...(validTo ? { validTo } : {}),
      reason: "inferred from legacy capture and current lineage fields",
      inferred: true,
    },
  ];
}

export interface LifecycleProjection {
  persisted: MemoryLifecycleState;
  effective: MemoryLifecycleState;
  persistedReason: string;
  effectiveReason: string;
}

/** Source status influences only the read-time current projection. Real drift
 * or missing/unavailable evidence projects to needs_revalidation without a
 * write. A normalized-content cosmetic match remains active but stays visibly
 * labeled `cosmetic_drift`; it is never promoted to raw-byte verification. */
export function lifecycleProjection(
  memory: Memory | null,
  sourceStatus:
    | "matched"
    | "cosmetic_drift"
    | "drifted"
    | "missing"
    | "unknown",
  sourceUnavailable = false,
): LifecycleProjection {
  const persisted = memory ? persistedLifecycleOf(memory) : "active";
  const persistedReason = memory
    ? persistedLifecycleReason(memory)
    : "observation defaults to active (no persisted Memory lifecycle)";
  if (
    persisted === "active" &&
    (sourceStatus === "drifted" ||
      sourceStatus === "missing" ||
      (sourceStatus === "unknown" && sourceUnavailable))
  ) {
    return {
      persisted,
      effective: "needs_revalidation",
      persistedReason,
      effectiveReason:
        sourceStatus === "missing"
          ? "live source evidence is missing"
          : sourceStatus === "drifted"
            ? "live source evidence drifted from its capture commitment"
            : "source evidence cannot be checked in an available checkout",
    };
  }
  return {
    persisted,
    effective: persisted,
    persistedReason,
    effectiveReason: persistedReason,
  };
}

export function initializeMemoryLifecycle(
  at: string,
  reason = "memory created",
  actor?: string,
): Pick<
  Memory,
  | "observedAt"
  | "validFrom"
  | "validityIntervals"
  | "lifecycle"
  | "lifecycleReason"
  | "lifecycleChangedAt"
  | "lifecycleTransitions"
> {
  const timestamp = validIso(at, "at");
  const cleanReason = validateReason(reason);
  const cleanActor = validateActor(actor);
  const transition: MemoryLifecycleTransition = {
    from: null,
    to: "active",
    action: "create",
    at: timestamp,
    reason: cleanReason,
    ...(cleanActor ? { actor: cleanActor } : {}),
  };
  return {
    observedAt: timestamp,
    validFrom: timestamp,
    validityIntervals: [{ validFrom: timestamp, reason: cleanReason }],
    lifecycle: "active",
    lifecycleReason: cleanReason,
    lifecycleChangedAt: timestamp,
    lifecycleTransitions: [transition],
  };
}

/** Explicit additive migration used at import/export boundaries. Normal reads
 * use the derived helpers above and never write this back. */
export function migrateLegacyMemoryLifecycle(memory: Memory): Memory {
  if (
    isMemoryLifecycleState(memory.lifecycle) &&
    parseTime(memory.observedAt) !== null &&
    parseTime(memory.validFrom) !== null &&
    Array.isArray(memory.validityIntervals) &&
    memory.validityIntervals.length > 0 &&
    typeof memory.lifecycleReason === "string" &&
    parseTime(memory.lifecycleChangedAt) !== null
  ) {
    return memory;
  }
  const state = persistedLifecycleOf(memory);
  const intervals = validityIntervalsOf(memory);
  const observedAt =
    parseTime(memory.observedAt) !== null
      ? memory.observedAt
      : parseTime(memory.provenance?.capturedAt) !== null
        ? memory.provenance!.capturedAt
        : parseTime(memory.createdAt) !== null
          ? memory.createdAt
          : undefined;
  const latest = intervals[intervals.length - 1];
  return {
    ...memory,
    ...(observedAt ? { observedAt } : {}),
    ...(memory.validFrom
      ? {}
      : latest?.validFrom
        ? { validFrom: latest.validFrom }
        : {}),
    ...(memory.validTo
      ? {}
      : latest?.validTo
        ? { validTo: latest.validTo }
        : {}),
    ...(memory.validityIntervals ? {} : { validityIntervals: intervals }),
    ...(memory.lifecycle ? {} : { lifecycle: state }),
    ...(memory.lifecycleReason
      ? {}
      : { lifecycleReason: persistedLifecycleReason(memory) }),
    ...(memory.lifecycleChangedAt
      ? {}
      : parseTime(memory.updatedAt) !== null
        ? { lifecycleChangedAt: memory.updatedAt }
        : observedAt
          ? { lifecycleChangedAt: observedAt }
          : {}),
    lifecycleMigratedFromLegacy: true,
  };
}

export type MemoryLifecycleMetadata = Pick<
  Memory,
  | "observedAt"
  | "validFrom"
  | "validTo"
  | "validityIntervals"
  | "lifecycle"
  | "lifecycleReason"
  | "lifecycleChangedAt"
  | "lifecycleTransitions"
  | "lifecycleMigratedFromLegacy"
>;

/** Copy only lifecycle/time metadata, applying safe legacy defaults without
 * accidentally carrying unrelated retention/content fields into a rewrite. */
export function memoryLifecycleMetadata(
  memory: Memory,
): MemoryLifecycleMetadata {
  const migrated = migrateLegacyMemoryLifecycle(memory);
  return {
    ...(migrated.observedAt ? { observedAt: migrated.observedAt } : {}),
    ...(migrated.validFrom ? { validFrom: migrated.validFrom } : {}),
    ...(migrated.validTo ? { validTo: migrated.validTo } : {}),
    ...(migrated.validityIntervals
      ? { validityIntervals: migrated.validityIntervals }
      : {}),
    lifecycle: migrated.lifecycle!,
    lifecycleReason: migrated.lifecycleReason!,
    ...(migrated.lifecycleChangedAt
      ? { lifecycleChangedAt: migrated.lifecycleChangedAt }
      : {}),
    ...(migrated.lifecycleTransitions
      ? { lifecycleTransitions: migrated.lifecycleTransitions }
      : {}),
    ...(migrated.lifecycleMigratedFromLegacy
      ? { lifecycleMigratedFromLegacy: true as const }
      : {}),
  };
}

function validateReason(reason: string): string {
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("reason is required");
  }
  const clean = reason.trim();
  if (clean.length > MAX_LIFECYCLE_REASON_CHARS) {
    throw new Error(
      `reason must be at most ${MAX_LIFECYCLE_REASON_CHARS} characters`,
    );
  }
  return clean;
}

function validateActor(actor: string | undefined): string | undefined {
  if (actor === undefined) return undefined;
  if (typeof actor !== "string" || !actor.trim()) {
    throw new Error("actor must be a non-empty string");
  }
  const clean = actor.trim();
  if (clean.length > MAX_LIFECYCLE_ACTOR_CHARS) {
    throw new Error(`actor must be at most ${MAX_LIFECYCLE_ACTOR_CHARS} characters`);
  }
  return clean;
}

const ACTION_TARGET: Record<
  Exclude<MemoryLifecycleAction, "create">,
  MemoryLifecycleState
> = {
  mark_needs_revalidation: "needs_revalidation",
  supersede: "superseded",
  dispute: "disputed",
  archive: "archived",
  revoke: "revoked",
  restore: "active",
  revalidate: "active",
};

const ALLOWED_ACTIONS: Record<
  MemoryLifecycleState,
  ReadonlySet<Exclude<MemoryLifecycleAction, "create">>
> = {
  active: new Set([
    "mark_needs_revalidation",
    "supersede",
    "dispute",
    "archive",
    "revoke",
  ]),
  needs_revalidation: new Set([
    "supersede",
    "dispute",
    "archive",
    "revoke",
    "revalidate",
  ]),
  disputed: new Set([
    "mark_needs_revalidation",
    "supersede",
    "archive",
    "revoke",
    "restore",
  ]),
  archived: new Set(["supersede", "dispute", "revoke", "restore"]),
  revoked: new Set(["supersede", "restore"]),
  superseded: new Set(),
};

export function isValidRecordedLifecycleTransition(
  value: unknown,
): value is MemoryLifecycleTransition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const transition = value as Partial<MemoryLifecycleTransition>;
  if (
    !isMemoryLifecycleState(transition.to) ||
    (transition.from !== null && !isMemoryLifecycleState(transition.from)) ||
    typeof transition.action !== "string" ||
    !["create", ...MEMORY_LIFECYCLE_ACTIONS].includes(transition.action) ||
    typeof transition.at !== "string" ||
    parseTime(transition.at) === null ||
    typeof transition.reason !== "string" ||
    !transition.reason.trim() ||
    transition.reason.length > MAX_LIFECYCLE_REASON_CHARS ||
    (transition.actor !== undefined &&
      (typeof transition.actor !== "string" ||
        !transition.actor.trim() ||
        transition.actor.length > MAX_LIFECYCLE_ACTOR_CHARS)) ||
    (transition.supersededBy !== undefined &&
      (typeof transition.supersededBy !== "string" ||
        !transition.supersededBy.trim() ||
        transition.supersededBy.length > 512))
  ) {
    return false;
  }
  if (transition.action === "create") {
    return transition.from === null && transition.to === "active";
  }
  const action = transition.action as Exclude<MemoryLifecycleAction, "create">;
  return (
    transition.from !== null &&
    ACTION_TARGET[action] === transition.to &&
    ALLOWED_ACTIONS[transition.from].has(action) &&
    (action !== "supersede" ||
      (typeof transition.supersededBy === "string" &&
        transition.supersededBy.length > 0))
  );
}

function lifecycleHistoryIsValid(memory: Memory): boolean {
  if (memory.lifecycleTransitions === undefined) return true;
  if (
    !Array.isArray(memory.lifecycleTransitions) ||
    memory.lifecycleTransitions.length > MAX_LIFECYCLE_TRANSITIONS
  ) {
    return false;
  }
  let prior = -Infinity;
  for (const transition of memory.lifecycleTransitions) {
    if (!isValidRecordedLifecycleTransition(transition)) return false;
    const at = Date.parse(transition.at);
    if (at < prior) return false;
    prior = at;
  }
  const last = memory.lifecycleTransitions.at(-1);
  return !last || !isMemoryLifecycleState(memory.lifecycle) || last.to === memory.lifecycle;
}

export interface ApplyLifecycleTransitionInput {
  action: Exclude<MemoryLifecycleAction, "create">;
  reason: string;
  at: string;
  actor?: string;
  supersededBy?: string;
}

/** Validates and records one explicit transition while retaining content and
 * every prior transition/validity interval. */
export function applyMemoryLifecycleTransition(
  memory: Memory,
  input: ApplyLifecycleTransitionInput,
): Memory {
  if (!MEMORY_LIFECYCLE_ACTIONS.includes(input.action)) {
    throw new Error(`unsupported lifecycle action: ${String(input.action)}`);
  }
  const from = persistedLifecycleOf(memory);
  if (!ALLOWED_ACTIONS[from].has(input.action)) {
    throw new Error(`invalid lifecycle transition: ${from} -> ${input.action}`);
  }
  const at = validIso(input.at, "at");
  const atMs = Date.parse(at);
  const reason = validateReason(input.reason);
  const actor = validateActor(input.actor);
  if (
    memory.lifecycleTransitions !== undefined &&
    !Array.isArray(memory.lifecycleTransitions)
  ) {
    throw new Error("stored lifecycle transition history is invalid");
  }
  const transitions = [...(memory.lifecycleTransitions ?? [])];
  let priorTransitionAt = -Infinity;
  for (const transition of transitions) {
    if (!isValidRecordedLifecycleTransition(transition)) {
      throw new Error("stored lifecycle transition history is invalid");
    }
    const transitionAt = Date.parse(transition.at);
    if (transitionAt < priorTransitionAt) {
      throw new Error("stored lifecycle transition history is invalid");
    }
    priorTransitionAt = transitionAt;
  }
  const lastTransition = transitions.at(-1);
  if (lastTransition && lastTransition.to !== from) {
    throw new Error("stored lifecycle state disagrees with transition history");
  }
  if (atMs < priorTransitionAt) {
    throw new Error("transition time must not precede the latest transition");
  }
  if (transitions.length >= MAX_LIFECYCLE_TRANSITIONS) {
    throw new Error(
      `lifecycle transition history is full (${MAX_LIFECYCLE_TRANSITIONS} entries)`,
    );
  }
  const to = ACTION_TARGET[input.action];
  let supersededBy: string | undefined;
  if (input.action === "supersede") {
    if (typeof input.supersededBy !== "string" || !input.supersededBy.trim()) {
      throw new Error("supersededBy is required for supersede");
    }
    supersededBy = input.supersededBy.trim();
    if (supersededBy === memory.id) {
      throw new Error("a memory cannot supersede itself");
    }
  }

  const transition: MemoryLifecycleTransition = {
    from,
    to,
    action: input.action,
    at,
    reason,
    ...(actor ? { actor } : {}),
    ...(supersededBy ? { supersededBy } : {}),
  };
  transitions.push(transition);

  const intervals = validityIntervalsOf(memory).map((interval) => ({
    ...interval,
  }));
  if (
    Array.isArray(memory.validityIntervals) &&
    memory.validityIntervals.length > 0 &&
    intervals.length === 0
  ) {
    throw new Error("stored validity interval history is invalid");
  }
  if (to === "active") {
    const latestInterval = intervals[intervals.length - 1];
    if (
      latestInterval?.validTo &&
      atMs < Date.parse(latestInterval.validTo)
    ) {
      throw new Error("transition time must not overlap an earlier validity interval");
    }
    intervals.push({ validFrom: at, reason });
  } else {
    const open = [...intervals].reverse().find((interval) => !interval.validTo);
    if (open) {
      if (atMs < Date.parse(open.validFrom)) {
        throw new Error("transition time must not precede validFrom");
      }
      open.validTo = at;
    }
  }
  const latest = intervals[intervals.length - 1];
  // Omit an old top-level validTo when this transition opens a new interval;
  // exactOptionalPropertyTypes intentionally prevents writing `undefined`.
  const { validTo: _previousValidTo, ...withoutValidTo } = memory;

  return {
    ...withoutValidTo,
    updatedAt: at,
    lifecycle: to,
    lifecycleReason: reason,
    lifecycleChangedAt: at,
    lifecycleTransitions: transitions,
    validityIntervals: intervals,
    ...(latest?.validFrom ? { validFrom: latest.validFrom } : {}),
    ...(latest?.validTo ? { validTo: latest.validTo } : {}),
    ...(to === "superseded"
      ? { isLatest: false, supersededBy: supersededBy! }
      : { isLatest: memory.isLatest !== false }),
  };
}

export interface AsOfLifecycleResult {
  available: boolean;
  active: boolean;
  reconstruction: "exact" | "legacy_inferred" | "unavailable";
  reason: string;
  interval?: MemoryValidityInterval;
}

/** Time-only as-of reconstruction over stored content versions and validity
 * intervals. Oplog payload hashes are deliberately not consulted: commitments
 * cannot reconstruct content. */
export function evaluateMemoryAsOf(
  memory: Memory,
  asOf: string | number | Date,
): AsOfLifecycleResult {
  const at =
    asOf instanceof Date
      ? asOf.getTime()
      : typeof asOf === "number"
        ? asOf
        : Date.parse(asOf);
  if (!Number.isFinite(at)) {
    return {
      available: false,
      active: false,
      reconstruction: "unavailable",
      reason: "as_of is not a valid date-time",
    };
  }
  const intervals = validityIntervalsOf(memory);
  if (intervals.length === 0) {
    return {
      available: false,
      active: false,
      reconstruction: "unavailable",
      reason: "this record has no reconstructible validity interval",
    };
  }
  const interval = intervals.find((candidate) => {
    const from = Date.parse(candidate.validFrom);
    const to = candidate.validTo ? Date.parse(candidate.validTo) : Infinity;
    return at >= from && at < to;
  });
  const inferred = interval
    ? interval.inferred === true
    : intervals.some((candidate) => candidate.inferred === true);
  return {
    available: true,
    active: Boolean(interval),
    reconstruction: inferred ? "legacy_inferred" : "exact",
    reason: interval
      ? inferred
        ? "active at as_of according to a conservatively inferred legacy interval"
        : "active at as_of according to a recorded validity interval"
      : "no validity interval covers as_of",
    ...(interval ? { interval } : {}),
  };
}
