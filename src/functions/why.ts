//
// mem::why — explain one memory's trust verdict against the live repo.
// The complementary surface to the firewall: when SessionStart says it
// refused something (or when doctor lists a stale id), this is the one-
// command answer to "why?".
//

import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type {
  CompressedObservation,
  Memory,
  Provenance,
  Session,
} from "./types.js";
import { KV } from "../state/schema.js";
import { classifyProvenance, type Verdict } from "./verify.js";
import { memoryToObservation } from "./memory-utils.js";
import {
  projectIdentityMatchesPath,
  resolveMemoryIdentity,
  sessionProjectIdentity,
} from "./memory-identity.js";
import { getRecallPolicy } from "./config.js";
import { trustLabelOf, type TrustLabel } from "./search.js";
import {
  defangTag,
  frameWhyContent,
  stripUnsafeControlCharacters,
  WHY_CONTENT_TAG,
} from "./injection-format.js";

/** Hard response bounds for explicitly requested refused content. */
export const WHY_CONTENT_MAX_CHARACTERS = 8_000;
export const WHY_CONTENT_MAX_LINES = 20;

export interface WhyResult {
  found: boolean;
  observationId: string;
  observation?: {
    id: string;
    /** Present by default only when the active policy admits the record. */
    title?: string;
    /** Present by default only when the active policy admits the record. */
    narrative?: string;
    type: string;
    timestamp: string;
    sessionId: string;
    /** Content-derived metadata follows the same withholding rule. */
    concepts?: string[];
  };
  session?: {
    id: string;
    project: string;
    cwd: string;
    agentId?: string;
    projectKey?: string;
  };
  verdict?: Verdict & { trust: TrustLabel };
  /** Would this memory be auto-injected under the current recall policy? */
  injectable?: boolean;
  provenance?: CompressedObservation["provenance"];
  /** Bounded, sanitized, delimiter-safe data returned only by explicit opt-in. */
  content?: string;
  contentTruncated?: boolean;
  advice?: string;
  reason?: string;
}

interface WhyInput {
  observationId?: string;
  observation_id?: string;
  root?: string;
  includeContent?: boolean;
  include_content?: boolean;
}

type WhyObservation = NonNullable<WhyResult["observation"]>;
type WhySession = NonNullable<WhyResult["session"]>;

function adviceFor(verdict: Verdict, injectable: boolean): string {
  switch (verdict.status) {
    case "verified":
      return injectable
        ? "Code-backed and byte-identical to capture — safe to auto-inject."
        : "Verified, but the current recall policy still withholds it.";
    case "cosmetic":
      return injectable
        ? "Code-backed and normalized-content current — line endings or trailing whitespace differ, so it is labeled [source-cosmetic]."
        : "Normalized content is current, but the current recall policy still withholds it.";
    case "sourced_unverified":
      return injectable
        ? "Sourced but not hash-verified — injected under balanced policy, labeled [sourced]."
        : "Sourced but not hash-verified — withheld under verified-only policy. Set MEMWARDEN_RECALL_POLICY=balanced to allow labeled injection.";
    case "stale":
      return (
        "Refused: source files changed or were deleted since capture. " +
        "Forget it with `memwarden forget " +
        "<id>`, or re-capture the fact after confirming the new truth. " +
        "Bulk: `memwarden doctor . --fix-stale`."
      );
    case "unsourced":
      return injectable
        ? "No evidence trail — injected under balanced policy, labeled [unsourced]."
        : "No evidence trail — withheld under verified-only policy.";
  }
}

function isInjectable(verdict: Verdict): boolean {
  const policy = getRecallPolicy();
  return (
    verdict.status !== "stale" &&
    (policy === "balanced" ||
      verdict.status === "verified" ||
      verdict.status === "cosmetic")
  );
}

/** Sanitize one why-response string without flattening legitimate LF lines. */
function sanitizeWhyText(value: string): string {
  return defangTag(stripUnsafeControlCharacters(value), WHY_CONTENT_TAG);
}

/** Metadata is always one line so a hostile path cannot forge renderer rows. */
function sanitizeWhyLine(value: string): string {
  return sanitizeWhyText(value).replace(/\s*\n\s*/g, " ");
}

/**
 * Provenance contains attacker-influenced command/path strings, including
 * object keys in the hash maps. Sanitize a response copy only; classification
 * and the stored evidence continue to use the exact original paths.
 */
function sanitizeMetadata<T>(value: T): T {
  if (typeof value === "string") return sanitizeWhyLine(value) as T;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadata(item)) as T;
  }
  if (value && typeof value === "object") {
    // Null prototype keeps a filename such as "__proto__" as inert evidence
    // rather than invoking Object.prototype's legacy setter.
    const sanitized: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      sanitized[sanitizeWhyLine(key)] = sanitizeMetadata(item);
    }
    return sanitized as T;
  }
  return value;
}

function observationFor(
  obs: CompressedObservation,
  sessionId: string,
  exposeInspectionContent: boolean,
): WhyObservation {
  return {
    id: sanitizeWhyLine(obs.id),
    ...(exposeInspectionContent
      ? {
          title: sanitizeWhyLine(obs.title),
          narrative: sanitizeWhyText(obs.narrative),
          ...(obs.concepts
            ? { concepts: obs.concepts.map(sanitizeWhyLine) }
            : {}),
        }
      : {}),
    type: sanitizeWhyLine(obs.type),
    timestamp: sanitizeWhyLine(obs.timestamp),
    sessionId: sanitizeWhyLine(sessionId),
  };
}

function sessionFor(session: Session, projectKey?: string): WhySession {
  return {
    id: sanitizeWhyLine(session.id),
    project: sanitizeWhyLine(session.project),
    cwd: sanitizeWhyLine(session.cwd),
    ...(session.agentId
      ? { agentId: sanitizeWhyLine(session.agentId) }
      : {}),
    ...(projectKey ? { projectKey: sanitizeWhyLine(projectKey) } : {}),
  };
}

function requestedContent(obs: CompressedObservation): {
  content: string;
  contentTruncated: boolean;
} {
  // Defang before bounding. Entity expansion therefore cannot make the
  // attacker-controlled payload exceed either advertised hard limit.
  const sanitized = defangTag(
    stripUnsafeControlCharacters(
      `title: ${obs.title}\nnarrative:\n${obs.narrative}`,
    ),
    WHY_CONTENT_TAG,
  );
  const lines = sanitized.split("\n");
  let bounded = lines.slice(0, WHY_CONTENT_MAX_LINES).join("\n");
  let contentTruncated = lines.length > WHY_CONTENT_MAX_LINES;
  if (bounded.length > WHY_CONTENT_MAX_CHARACTERS) {
    bounded = bounded.slice(0, WHY_CONTENT_MAX_CHARACTERS);
    contentTruncated = true;
  }
  return {
    content: frameWhyContent(bounded),
    contentTruncated,
  };
}

function foundResult(input: {
  observationId: string;
  observation: CompressedObservation;
  session?: Session;
  projectKey?: string;
  verdict: Verdict;
  provenance?: Provenance;
  includeContent: boolean;
}): WhyResult {
  const injectable = isInjectable(input.verdict);
  const trust = trustLabelOf(input.verdict);
  return {
    found: true,
    observationId: sanitizeWhyLine(input.observationId),
    observation: observationFor(
      input.observation,
      input.observation.sessionId,
      injectable,
    ),
    ...(input.session
      ? { session: sessionFor(input.session, input.projectKey) }
      : {}),
    verdict: sanitizeMetadata({ ...input.verdict, trust }),
    injectable,
    ...(input.provenance
      ? { provenance: sanitizeMetadata(input.provenance) }
      : {}),
    ...(input.includeContent ? requestedContent(input.observation) : {}),
    advice: sanitizeWhyLine(
      adviceFor(input.verdict, injectable).replace(
        "<id>",
        input.observationId,
      ),
    ),
  };
}

export function registerWhyFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::why",
    async (data: WhyInput): Promise<WhyResult> => {
      const observationId =
        (typeof data?.observationId === "string" && data.observationId.trim()) ||
        (typeof data?.observation_id === "string" && data.observation_id.trim()) ||
        "";
      if (!observationId) {
        return {
          found: false,
          observationId: "",
          reason: "observationId is required",
        };
      }
      const root =
        typeof data?.root === "string" && data.root.trim()
          ? data.root.trim()
          : process.cwd();
      // Runtime callers do not get truthy coercion: only an explicit boolean
      // true can cross the withholding boundary.
      const includeContent =
        data?.include_content === true || data?.includeContent === true;

      const sessions = await kv.list<Session>(KV.sessions);
      const sessionsById = new Map(sessions.map((session) => [session.id, session]));
      for (const session of sessions) {
        if (!session?.id) continue;
        const obs = await kv
          .get<CompressedObservation>(KV.observations(session.id), observationId)
          .catch(() => null);
        if (!obs) continue;
        const identity = sessionProjectIdentity(session);
        const verdict = classifyProvenance(obs.provenance, root, {
          // Stable identity decides that re-rooting is safe; `root` remains
          // the caller's checkout path actually read by the verifier.
          verifyAgainstRoot: projectIdentityMatchesPath(identity, root),
        });
        return foundResult({
          observationId,
          observation: obs,
          session,
          ...(session.projectKey ? { projectKey: session.projectKey } : {}),
          verdict,
          ...(obs.provenance ? { provenance: obs.provenance } : {}),
          includeContent,
        });
      }

      // Explicit memories (mem::remember / MCP) live under KV.memories.
      const memory = await kv
        .get<Memory>(KV.memories, observationId)
        .catch(() => null);
      if (memory) {
        const identity = resolveMemoryIdentity(memory, sessionsById);
        const obs = memoryToObservation(memory, identity);
        const verdict = classifyProvenance(obs.provenance, root, {
          verifyAgainstRoot: projectIdentityMatchesPath(identity, root),
        });
        return foundResult({
          observationId,
          observation: obs,
          ...(identity.sourceSession
            ? { session: identity.sourceSession }
            : {}),
          ...(identity.projectKey ? { projectKey: identity.projectKey } : {}),
          verdict,
          ...(obs.provenance ? { provenance: obs.provenance } : {}),
          includeContent,
        });
      }

      return {
        found: false,
        observationId: sanitizeWhyLine(observationId),
        reason: "No observation or memory with that id in this brain",
      };
    },
  );
}
