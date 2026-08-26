//
// mem::why — explain one memory's trust verdict against the live repo.
// The complementary surface to the firewall: when SessionStart says it
// refused something (or when doctor lists a stale id), this is the one-
// command answer to "why?".

import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import type { CompressedObservation, Memory, Session } from "./types.js";
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

export interface WhyResult {
  found: boolean;
  observationId: string;
  observation?: {
    id: string;
    title: string;
    narrative: string;
    type: string;
    timestamp: string;
    sessionId: string;
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
  advice?: string;
  reason?: string;
}

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

export function registerWhyFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::why",
    async (data: {
      observationId?: string;
      observation_id?: string;
      root?: string;
    }): Promise<WhyResult> => {
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

      const sessions = await kv.list<Session>(KV.sessions);
      const sessionsById = new Map(sessions.map((session) => [session.id, session]));
      for (const s of sessions) {
        if (!s?.id) continue;
        const obs = await kv
          .get<CompressedObservation>(KV.observations(s.id), observationId)
          .catch(() => null);
        if (!obs) continue;
        const identity = sessionProjectIdentity(s);
        const verdict = classifyProvenance(obs.provenance, root, {
          // Stable identity decides that re-rooting is safe; `root` remains
          // the caller's checkout path actually read by the verifier.
          verifyAgainstRoot: projectIdentityMatchesPath(identity, root),
        });
        const trust = trustLabelOf(verdict);
        const policy = getRecallPolicy();
        const injectable =
          verdict.status !== "stale" &&
          (policy === "balanced" ||
            verdict.status === "verified" ||
            verdict.status === "cosmetic");
        return {
          found: true,
          observationId,
          observation: {
            id: obs.id,
            title: obs.title,
            narrative: obs.narrative,
            type: obs.type,
            timestamp: obs.timestamp,
            sessionId: s.id,
            ...(obs.concepts ? { concepts: obs.concepts } : {}),
          },
          session: {
            id: s.id,
            project: s.project,
            cwd: s.cwd,
            ...(s.agentId ? { agentId: s.agentId } : {}),
            ...(s.projectKey ? { projectKey: s.projectKey } : {}),
          },
          verdict: { ...verdict, trust },
          injectable,
          provenance: obs.provenance,
          advice: adviceFor(verdict, injectable).replace("<id>", observationId),
        };
      }

      // Explicit memories (mem::remember / MCP) live under KV.memories.
      const mem = await kv.get<Memory>(KV.memories, observationId).catch(() => null);
      if (mem) {
        const identity = resolveMemoryIdentity(mem, sessionsById);
        const obs = memoryToObservation(mem, identity);
        const verdict = classifyProvenance(obs.provenance, root, {
          verifyAgainstRoot: projectIdentityMatchesPath(identity, root),
        });
        const trust = trustLabelOf(verdict);
        const policy = getRecallPolicy();
        const injectable =
          verdict.status !== "stale" &&
          (policy === "balanced" ||
            verdict.status === "verified" ||
            verdict.status === "cosmetic");
        const sourceSession = identity.sourceSession;
        return {
          found: true,
          observationId,
          observation: {
            id: obs.id,
            title: obs.title,
            narrative: obs.narrative,
            type: obs.type,
            timestamp: obs.timestamp,
            sessionId: obs.sessionId,
          },
          ...(sourceSession
            ? {
                session: {
                  id: sourceSession.id,
                  project: sourceSession.project,
                  cwd: sourceSession.cwd,
                  ...(sourceSession.agentId
                    ? { agentId: sourceSession.agentId }
                    : {}),
                  ...(identity.projectKey
                    ? { projectKey: identity.projectKey }
                    : {}),
                },
              }
            : {}),
          verdict: { ...verdict, trust },
          injectable,
          provenance: obs.provenance,
          advice: adviceFor(verdict, injectable).replace("<id>", observationId),
        };
      }

      return {
        found: false,
        observationId,
        reason: "No observation or memory with that id in this brain",
      };
    },
  );
}
