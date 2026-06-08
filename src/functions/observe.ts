//
// The write path (mem::observe). Ported from the original
// src/functions/observe.ts. Accepts a HookPayload, validates it, optionally
// dedups, privacy-strips the raw payload, builds a RawObservation, then —
// inside a per-session keyed lock — enforces the per-session cap, persists
// the raw observation, updates/creates the session row (observationCount++,
// updatedAt, firstPrompt), and runs the default zero-LLM synthetic
// compression path: write the synthetic over the same obsId, add it to the
// BM25 index, and (Phase 0b) the vector index. The set/update on
// KV.sessions flows through the StateStore, so the kernel's type:"state"
// trigger fires from the store's mutation event. Returns
// { observationId } so existing connectors see the same wire shape.
//
// PHASE-0 SCOPE: image *detection* + modality tagging is preserved (pure,
// keeps the observation wire shape compatible), but the image-to-disk
// persistence, ref-counting, vision-embed, and disk-size-delta side effects
// from the predecessor are not ported — they depend on the image-store /
// vision subsystem, which is out of the core. The live-viewer stream::set /
// stream::send fan-out is emitted (the kernel routes those built-ins to its
// in-process pub/sub); it is durably unused in-process. LLM compression
// (AUTO_COMPRESS) has no provider wired, so the synthetic path is always
// taken.

import { TriggerAction, type ISdk } from "../kernel/index.js";
import type { RawObservation, HookPayload } from "./types.js";
import { KV, STREAM, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { isAutoCompressEnabled, getAgentId } from "./config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { extractProvenance } from "./provenance.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";
import { logger } from "./logger.js";
import { metrics } from "../observability/metrics.js";

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
      dedupHash = dedupMap.computeHash(
        payload.sessionId,
        toolName,
        d["tool_input"],
      );
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
      if (payload.hookType === "prompt_submit") {
        if (typeof d["prompt"] === "string") raw.userPrompt = d["prompt"];
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
      }>(KV.sessions, payload.sessionId);
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
          ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
          ...(trimmedPrompt && trimmedPrompt.length > 0
            ? { firstPrompt: trimmedPrompt }
            : {}),
        });
      }

      // Per-observation LLM compression is opt-in .
      // Default path: build a zero-LLM synthetic compression so recall and
      // BM25 search work without an LLM. The successor has no LLM provider
      // wired in Phase 0, so the synthetic path is always taken.
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
        // Attach the evidence trail so the doctor can later judge whether
        // this memory is sourced and still valid.
        synthetic.provenance = extractProvenance(payload);
        metrics.recordObserve(JSON.stringify(raw), JSON.stringify(synthetic));
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
