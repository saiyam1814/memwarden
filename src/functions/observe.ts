//
// The write path (mem::observe). Accepts a HookPayload, validates it, optionally
// dedups, privacy-strips the raw payload, builds a RawObservation, then — inside
// a per-session keyed lock — enforces the per-session cap, persists the raw
// observation, updates/creates the session row (observationCount++, updatedAt,
// firstPrompt), and runs the default zero-LLM synthetic compression: write the
// synthetic over the same obsId and add it to the BM25 and vector indexes.
// Referenced files are hashed into provenance for Verified Recall. Returns
// { observationId }.
//
// Image detection + modality tagging are kept (pure, keeps the observation
// shape stable); image-to-disk persistence and vision embedding are out of
// scope. LLM-based compression (AUTO_COMPRESS) has no provider wired, so the
// synthetic path is always taken.

import { TriggerAction, type ISdk } from "../kernel/index.js";
import type {
  RawObservation,
  HookPayload,
  Session,
  CompressedObservation,
} from "./types.js";
import { projectKey } from "./git-identity.js";
import { canonicalizePath } from "./paths.js";
import { KV, STREAM, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { isAutoCompressEnabled, getAgentId } from "./config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { buildSessionHandoff, MAX_STORED_PROMPT_CHARS } from "./handoff.js";
import { extractProvenance } from "./provenance.js";
import { hashFiles } from "./verify.js";
import { recordFix, looksLikeResolvedFix } from "./dejafix.js";
import { getSearchIndex, vectorIndexAddGuarded, vectorIndexRemove } from "./search.js";
import { logger } from "./logger.js";
import { metrics } from "../observability/metrics.js";

/**
 * Defense-in-depth against sessionId reuse across projects.
 *
 * MCP and the proxy already mint per-project session ids
 * (`mcp-<hash>`, `proxy-<port>-<hash>`), but a forged or stale client can
 * still present an existing sessionId under a different project. A session's
 * project identity is fixed at creation — refuse the write rather than
 * silently attach foreign observations (which would make them searchable
 * under the wrong project and invisible under the right one).
 *
 * Prefer stable projectKey (survives worktrees / moved checkouts). Fall back
 * to canonical project/cwd paths when either side lacks a key. Insufficient
 * identity on either side fails open so legacy/partial payloads keep working.
 */
export function sessionProjectMismatch(
  session: {
    project?: string;
    cwd?: string;
    projectKey?: string;
  },
  incoming: {
    project?: string;
    cwd?: string;
    projectKey?: string;
  },
): boolean {
  if (session.projectKey && incoming.projectKey) {
    return session.projectKey !== incoming.projectKey;
  }
  if (
    typeof session.project === "string" &&
    session.project.trim().length > 0 &&
    typeof incoming.project === "string" &&
    incoming.project.trim().length > 0
  ) {
    return (
      canonicalizePath(session.project) !== canonicalizePath(incoming.project)
    );
  }
  if (
    typeof session.cwd === "string" &&
    session.cwd.trim().length > 0 &&
    typeof incoming.cwd === "string" &&
    incoming.cwd.trim().length > 0
  ) {
    return canonicalizePath(session.cwd) !== canonicalizePath(incoming.cwd);
  }
  return false;
}

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (
      d.startsWith("data:image/") ||
      d.startsWith("iVBORw0KGgo") ||
      d.startsWith("/9j/")
    ) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];

    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
): void {
  sdk.registerFunction("mem::observe", async (payload: HookPayload) => {
    if (
      !payload?.sessionId ||
      typeof payload.sessionId !== "string" ||
      !payload.hookType ||
      typeof payload.hookType !== "string" ||
      !payload.timestamp ||
      typeof payload.timestamp !== "string"
    ) {
      return {
        success: false,
        error:
          "Invalid payload: sessionId, hookType, and timestamp are required",
      };
    }

    const obsId = generateId("obs");

    let dedupHash: string | undefined;
    if (dedupMap) {
      const d =
        typeof payload.data === "object" && payload.data !== null
          ? (payload.data as Record<string, unknown>)
          : {};
      const toolName = (d["tool_name"] as string) || payload.hookType;
      // A prompt event's identity is its PROMPT, so two DIFFERENT prompts in
      // the same session never collide (only an identical retried prompt
      // inside the TTL window dedups). It is keyed on the prompt even when
      // tool_input rides along: `memwarden adopt` seeds foreign memories as
      // user_prompt events carrying tool_input for file provenance, and most
      // of a CLAUDE.md pile is unanchored prose sharing an empty file list —
      // keying on tool_input alone would collapse the whole store into one
      // memory and report the loss as "already present". The prompt leads the
      // object so it dominates the hash's leading-500-char window.
      // session_end is special: per-turn Stop hosts (Codex, Kiro) end EVERY
      // turn, and each stop should refresh the handoff — so its dedup input
      // includes the full data (assistant_response and all) AND the event
      // timestamp. Only a true duplicate delivery (same timestamp, same
      // data) dedups; a new turn's stop never gets swallowed.
      const isPromptHook =
        payload.hookType === "prompt_submit" || payload.hookType === "user_prompt";
      const dedupInput = isPromptHook
        ? { prompt: d["prompt"], tool_input: d["tool_input"] }
        : d["tool_input"] !== undefined
          ? d["tool_input"]
          : payload.hookType === "session_end"
            ? { data: d, ts: payload.timestamp }
            : d["prompt"];
      // The dedup key is scoped by project as well as session: without it, a
      // cross-project write into an existing session that happens to carry
      // identical data would short-circuit here as a silent "success" before
      // the session-project mismatch guard below ever sees it.
      const dedupScope = `${payload.sessionId}|${payload.project ?? payload.cwd ?? ""}`;
      dedupHash = dedupMap.computeHash(dedupScope, toolName, dedupInput);
      if (dedupMap.isDuplicate(dedupHash)) {
        return { deduplicated: true, sessionId: payload.sessionId };
      }
    }

    let sanitizedRaw: unknown = payload.data;
    try {
      const jsonStr = JSON.stringify(payload.data);
      const sanitized = stripPrivateData(jsonStr);
      sanitizedRaw = JSON.parse(sanitized);
    } catch {
      sanitizedRaw = stripPrivateData(String(payload.data));
    }

    const raw: RawObservation = {
      id: obsId,
      sessionId: payload.sessionId,
      timestamp: payload.timestamp,
      hookType: payload.hookType,
      raw: sanitizedRaw,
    };

    // Project identity (additive): a stable key that survives worktrees and
    // moved checkouts, stored ALONGSIDE the path fields — recall uses it only
    // to widen path scoping, so key-less data behaves exactly as before.
    const stableProjectKey =
      typeof payload.cwd === "string" && payload.cwd.trim().length > 0
        ? projectKey(payload.cwd)
        : undefined;
    if (stableProjectKey) raw.projectKey = stableProjectKey;

    let extractedImage: string | undefined;

    if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
      const d = sanitizedRaw as Record<string, unknown>;
      if (
        payload.hookType === "post_tool_use" ||
        payload.hookType === "post_tool_failure"
      ) {
        if (typeof d["tool_name"] === "string") raw.toolName = d["tool_name"];
        raw.toolInput = d["tool_input"];
        raw.toolOutput = d["tool_output"] || d["error"];
      }
      if (
        payload.hookType === "prompt_submit" ||
        payload.hookType === "user_prompt"
      ) {
        // The prompt is first-class memory. It already went through
        // stripPrivateData above (same secret-redaction path as tool output);
        // cap length so a pasted novella cannot bloat the store.
        if (typeof d["prompt"] === "string") {
          raw.userPrompt = d["prompt"].slice(0, MAX_STORED_PROMPT_CHARS);
        }
      }
      if (payload.hookType === "session_end" || payload.hookType === "stop") {
        // The assistant's final message — the session OUTCOME. Hook clients
        // send it as assistant_response (mapped from Codex
        // last_assistant_message / Kiro assistant_response); same privacy
        // strip + cap as prompts.
        if (typeof d["assistant_response"] === "string") {
          raw.assistantResponse = d["assistant_response"].slice(
            0,
            MAX_STORED_PROMPT_CHARS,
          );
        }
      }

      extractedImage = extractImage(sanitizedRaw);
      if (extractedImage) {
        raw.modality =
          raw.toolInput || raw.toolOutput || raw.userPrompt
            ? "mixed"
            : "image";
      }
    } else if (typeof sanitizedRaw === "string") {
      extractedImage = extractImage(sanitizedRaw);
      if (extractedImage) {
        raw.modality = "image";
      }
    }

    return withKeyedLock(`obs:${payload.sessionId}`, async () => {
      if (maxObservationsPerSession && maxObservationsPerSession > 0) {
        const existing = await kv.list(KV.observations(payload.sessionId));
        if (existing.length >= maxObservationsPerSession) {
          return {
            success: false,
            error: `Session observation limit reached (${maxObservationsPerSession})`,
          };
        }
      }

      // Existing session is the source of truth for agentId (even
      // undefined). Env AGENT_ID only fires when no session row exists yet —
      // otherwise an unscoped session would get retroactively scoped by a
      // later AGENT_ID export.
      const existingSession = await kv.get<{
        agentId?: string;
        observationCount?: number;
        firstPrompt?: string;
        project?: string;
        cwd?: string;
        projectKey?: string;
      }>(KV.sessions, payload.sessionId);

      // Defense-in-depth: refuse cross-project writes into an existing session
      // (MCP/proxy already mint per-project session ids; this catches reuse).
      if (
        existingSession &&
        sessionProjectMismatch(existingSession, {
          ...(typeof payload.project === "string"
            ? { project: payload.project }
            : {}),
          ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
          ...(stableProjectKey ? { projectKey: stableProjectKey } : {}),
        })
      ) {
        return {
          success: false,
          error:
            "Session project mismatch: observation project does not match the existing session",
        };
      }

      const inheritedAgentId = existingSession
        ? existingSession.agentId
        : getAgentId();
      if (inheritedAgentId) {
        raw.agentId = inheritedAgentId;
      }

      await kv.set(KV.observations(payload.sessionId), obsId, raw);

      if (dedupMap && dedupHash) {
        dedupMap.record(dedupHash);
      }

      // Live-viewer stream fan-out. The kernel routes stream::set /
      // stream::send to its in-process pub/sub. Durably unused in-process,
      // but kept so the viewer wiring stays identical.
      await sdk.trigger({
        function_id: "stream::set",
        payload: {
          stream_name: STREAM.name,
          group_id: STREAM.group(payload.sessionId),
          item_id: obsId,
          data: { type: "raw", observation: raw },
        },
      });

      sdk.trigger({
        function_id: "stream::send",
        payload: {
          stream_name: STREAM.name,
          group_id: STREAM.viewerGroup,
          id: `raw-${obsId}`,
          type: "raw_observation",
          data: {
            type: "raw",
            observation: raw,
            sessionId: payload.sessionId,
          },
        },
        action: TriggerAction.Void(),
      });

      const session = existingSession;
      if (session) {
        const updates: Array<{ type: "set"; path: string; value: unknown }> = [
          { type: "set", path: "updatedAt", value: new Date().toISOString() },
          {
            type: "set",
            path: "observationCount",
            value: (session.observationCount || 0) + 1,
          },
        ];
        if (!session.firstPrompt && typeof raw.userPrompt === "string") {
          const trimmed = raw.userPrompt.replace(/\s+/g, " ").trim();
          if (trimmed.length > 0) {
            updates.push({
              type: "set",
              path: "firstPrompt",
              value: trimmed.slice(0, 200),
            });
          }
        }
        await kv.update(KV.sessions, payload.sessionId, updates);
      } else if (
        typeof payload.project === "string" &&
        payload.project.trim().length > 0 &&
        typeof payload.cwd === "string" &&
        payload.cwd.trim().length > 0
      ) {
        // Connectors that skip POST /session/start can fire observations
        // before the session record exists. Create it now from the
        // observation payload — but only when project + cwd are present
        // (HookPayload contract). Older payloads without those fields keep
        // the original no-op behaviour.
        const trimmedPrompt =
          typeof raw.userPrompt === "string"
            ? raw.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
            : undefined;
        const ts = new Date().toISOString();
        await kv.set(KV.sessions, payload.sessionId, {
          id: payload.sessionId,
          project: payload.project,
          cwd: payload.cwd,
          startedAt: payload.timestamp ?? ts,
          updatedAt: ts,
          status: "active",
          observationCount: 1,
          ...(stableProjectKey ? { projectKey: stableProjectKey } : {}),
          ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
          ...(trimmedPrompt && trimmedPrompt.length > 0
            ? { firstPrompt: trimmedPrompt }
            : {}),
        });
      }

      // --- session_end: HANDOFF SUMMARY (session journal) ---------------
      // The session's stored observations + firstPrompt are synthesized into
      // a compact deterministic summary (goal / what happened / decisions /
      // open threads) — no LLM. Persisted three ways: Session.summary,
      // KV.summaries (mem::context renders it), and a searchable observation
      // written over this obsId — so session-start recall in ANOTHER tool
      // surfaces the handoff. This replaces generic compression entirely for
      // session_end events.
      if (payload.hookType === "session_end") {
        const stored = await kv.list<CompressedObservation>(
          KV.observations(payload.sessionId),
        );
        // Per-turn Stop hosts (Codex, Kiro) end EVERY turn: each stop must
        // REFRESH the session's handoff, not accumulate one per turn. Reuse
        // the existing handoff observation's slot when there is one.
        const existingHandoff = stored.find(
          (o) =>
            o &&
            o.type === "task" &&
            Array.isArray(o.concepts) &&
            o.concepts.includes("session-summary"),
        );
        const handoffId = existingHandoff?.id ?? obsId;
        const prior = stored.filter(
          (o) => o && o.id !== obsId && o.id !== handoffId,
        );
        const sess = await kv.get<Session>(KV.sessions, payload.sessionId);
        const handoff = buildSessionHandoff({
          obsId: handoffId,
          sessionId: payload.sessionId,
          timestamp: payload.timestamp,
          project:
            sess?.project ??
            (typeof payload.project === "string" && payload.project.trim()
              ? payload.project
              : undefined),
          firstPrompt: sess?.firstPrompt,
          agentId: raw.agentId,
          // The OUTCOME: the assistant's final message, when the stop event
          // carried one — so the handoff says how the session ended, not
          // just what happened along the way.
          assistantResponse: raw.assistantResponse,
          observations: prior,
        });

        if (existingHandoff) {
          // Refresh in place: drop the just-persisted raw session_end row
          // (subsumed by the refreshed handoff) and re-index the same id.
          await kv.delete(KV.observations(payload.sessionId), obsId);
          getSearchIndex().remove(handoffId);
          vectorIndexRemove(handoffId);
        }
        await kv.set(KV.observations(payload.sessionId), handoffId, handoff.observation);
        getSearchIndex().add(handoff.observation);
        await vectorIndexAddGuarded(
          handoffId,
          payload.sessionId,
          handoff.observation.title + " " + handoff.observation.narrative,
          { kind: "synthetic", logId: handoffId },
        );

        if (sess) {
          await kv.update(KV.sessions, payload.sessionId, [
            { type: "set", path: "summary", value: handoff.summaryText },
            { type: "set", path: "status", value: "completed" },
            { type: "set", path: "endedAt", value: payload.timestamp },
            // Keep the count honest across repeated stops (the refreshed
            // handoff replaces the raw row instead of adding to it).
            { type: "set", path: "observationCount", value: prior.length + 1 },
          ]);
          await kv.set(KV.summaries, payload.sessionId, handoff.sessionSummary);
        }

        await sdk.trigger({
          function_id: "stream::set",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.group(payload.sessionId),
            item_id: handoffId,
            data: { type: "compressed", observation: handoff.observation },
          },
        });

        logger.info("Session handoff captured", {
          obsId: handoffId,
          sessionId: payload.sessionId,
          observations: prior.length,
          refreshed: Boolean(existingHandoff),
        });
        return { observationId: handoffId };
      }

      // Per-observation LLM compression is opt-in .
      // Default path: build a zero-LLM synthetic compression so recall and
      // BM25 search work without an LLM. The memwarden has no LLM provider
      // wired in the core, so the synthetic path is always taken.
      if (isAutoCompressEnabled()) {
        await sdk.trigger({
          function_id: "mem::compress",
          payload: {
            observationId: obsId,
            sessionId: payload.sessionId,
            raw,
          },
          action: TriggerAction.Void(),
        });
      } else {
        const synthetic = buildSyntheticCompression(raw);
        // Attach the evidence trail so the doctor and Verified Recall can later
        // judge whether this memory is sourced and still valid. Hash the
        // referenced files now (under cwd) so content drift is detectable.
        const prov = extractProvenance(payload);
        // Adopted memories (seeded from a foreign store by `memwarden adopt`)
        // had no capture-time hashes. Hashing their files against the current
        // repo would forge a `verified` verdict for a fact that was never
        // content-anchored, so we keep the file references but never hash them
        // — classifyProvenance then caps them at `sourced_unverified`.
        if (!payload.adopted && prov.files && prov.files.length > 0 && payload.cwd) {
          const fileHashes = hashFiles(prov.files, payload.cwd);
          if (Object.keys(fileHashes).length > 0) prov.fileHashes = fileHashes;
        }
        synthetic.provenance = prov;
        metrics.recordObserve(JSON.stringify(raw), JSON.stringify(synthetic));

        // Déjà Fix opportunistic capture. When this observation already looks
        // like a recorded fix (contains BOTH a recognizable error AND
        // resolution language), extract its error signature and store a
        // FixMemory so any agent that later hits the same error can recall the
        // verified fix. Reuses the same provenance (with fileHashes) we just
        // built, so Verified Recall can detect drift. Strictly best-effort and
        // gated: it must never throw on or block the observe hot path, and
        // non-fix observations are completely untouched.
        try {
          const fixText = [
            synthetic.title,
            synthetic.narrative,
            ...(synthetic.facts ?? []),
          ]
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .join("\n");
          if (payload.cwd && looksLikeResolvedFix(fixText)) {
            const tool = raw.agentId ?? payload.agent;
            await recordFix(kv, {
              errorText: fixText,
              observationId: obsId,
              fix: synthetic.narrative || synthetic.title,
              provenance: prov,
              cwd: payload.cwd,
              timestamp: payload.timestamp,
              sessionId: payload.sessionId,
              ...(tool ? { tool } : {}),
            });
          }
        } catch (err) {
          // The side path must never break observe.
          logger.warn("dejafix opportunistic capture failed", {
            obsId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        await kv.set(KV.observations(payload.sessionId), obsId, synthetic);
        getSearchIndex().add(synthetic);
        await vectorIndexAddGuarded(
          synthetic.id,
          synthetic.sessionId,
          synthetic.title + " " + (synthetic.narrative || ""),
          { kind: "synthetic", logId: synthetic.id },
        );
        await sdk.trigger({
          function_id: "stream::set",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.group(payload.sessionId),
            item_id: obsId,
            data: { type: "compressed", observation: synthetic },
          },
        });
        await sdk.trigger({
          function_id: "stream::set",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.viewerGroup,
            item_id: obsId,
            data: {
              type: "compressed",
              observation: synthetic,
              sessionId: payload.sessionId,
            },
          },
        });
      }

      logger.info("Observation captured", {
        obsId,
        sessionId: payload.sessionId,
        hook: payload.hookType,
        compress: isAutoCompressEnabled() ? "llm" : "synthetic",
      });
      return { observationId: obsId };
    });
  });
}
