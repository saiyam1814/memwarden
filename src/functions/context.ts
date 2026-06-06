//
// Recency-packed context assembly (mem::context). Ported from
// the original src/functions/context.ts: assembles pinned slots + project
// profile + ranked lessons + recent same-project sessions (rendered from
// their summary, or from important observations when no summary exists),
// sorts blocks by recency, and greedily packs them under a token budget,
// wrapped in <the original implementation-context project="...">. The wire shape of the
// returned {context, blocks, tokens} is preserved so existing connectors
// see no change.
//
// NOTE (Phase 3): this is the existing recency-greedy budget behavior,
// ported as-is. The budget governor replaces this packing strategy in
// Phase 3; until then the greedy "sort by recency desc, drop blocks that
// don't fit" loop is intentionally identical to the predecessor.
//
// PHASE-0 SCOPE: memory slots are an optional context-injection feature
// (off by default). When MEMWARDEN_SLOTS is not "true"
// the pinned-slots block is empty, matching the original implementation. The full slots
// CRUD surface is not part of the core port, so listing/rendering pinned
// slots is a no-op here until the slots feature is ported.

import type { ISdk } from "../kernel/index.js";
import type {
  Session,
  CompressedObservation,
  SessionSummary,
  ContextBlock,
  ProjectProfile,
  Lesson,
} from "./types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAccessBatch } from "./access-tracker.js";
import { isSlotsEnabled } from "./config.js";
import { logger } from "./logger.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Phase-0 pinned-slots renderer. The full slots feature (CRUD + reflection)
 * is not part of the core port; when slots are disabled (the default) this
 * returns no content, exactly like the original listPinnedSlots/
 * renderPinnedContext yielding an empty string. Wired here so the block
 * lights up unchanged once slots are ported.
 */
async function renderPinnedSlots(_kv: StateKV): Promise<string> {
  if (!isSlotsEnabled()) return "";
  // Slots feature not yet ported; no pinned content until it lands.
  return "";
}

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction(
    "mem::context",
    async (data: { sessionId: string; project: string; budget?: number }) => {
      const budget = data.budget || tokenBudget;
      const blocks: ContextBlock[] = [];

      const [slotContent, profile, lessons] = await Promise.all([
        renderPinnedSlots(kv).catch(() => ""),
        kv.get<ProjectProfile>(KV.profiles, data.project).catch(() => null),
        kv.list<Lesson>(KV.lessons).catch(() => [] as Lesson[]),
      ]);

      if (slotContent) {
        blocks.push({
          type: "memory",
          content: slotContent,
          tokens: estimateTokens(slotContent),
          recency: Date.now(),
        });
      }
      if (profile) {
        const profileParts: string[] = [];
        if (profile.topConcepts.length > 0) {
          profileParts.push(
            `Concepts: ${profile.topConcepts
              .slice(0, 8)
              .map((c) => c.concept)
              .join(", ")}`,
          );
        }
        if (profile.topFiles.length > 0) {
          profileParts.push(
            `Key files: ${profile.topFiles
              .slice(0, 5)
              .map((f) => f.file)
              .join(", ")}`,
          );
        }
        if (profile.conventions.length > 0) {
          profileParts.push(`Conventions: ${profile.conventions.join("; ")}`);
        }
        if (profile.commonErrors.length > 0) {
          profileParts.push(
            `Common errors: ${profile.commonErrors.slice(0, 3).join("; ")}`,
          );
        }
        if (profileParts.length > 0) {
          const profileContent = `## Project Profile\n${profileParts.join("\n")}`;
          blocks.push({
            type: "memory",
            content: profileContent,
            tokens: estimateTokens(profileContent),
            recency: new Date(profile.updatedAt).getTime(),
          });
        }
      }

      // Lessons — ranking puts project-scoped lessons ahead of global ones,
      // then weights by confidence; capped at 10 to keep the block bounded.
      const relevantLessons = lessons
        .filter((l) => !l.deleted && (!l.project || l.project === data.project))
        .sort((a, b) => {
          const scoreA = (a.project === data.project ? 1.5 : 1) * a.confidence;
          const scoreB = (b.project === data.project ? 1.5 : 1) * b.confidence;
          return scoreB - scoreA;
        })
        .slice(0, 10);

      if (relevantLessons.length > 0) {
        const items = relevantLessons
          .map(
            (l) =>
              `- (${l.confidence.toFixed(2)}) ${l.content}${l.context ? ` — ${l.context}` : ""}`,
          )
          .join("\n");
        const lessonsContent = `## Lessons Learned\n${items}`;
        const mostRecent = relevantLessons.reduce((acc, l) => {
          const t = new Date(l.lastReinforcedAt || l.updatedAt).getTime();
          return t > acc ? t : acc;
        }, 0);
        blocks.push({
          type: "memory",
          content: lessonsContent,
          tokens: estimateTokens(lessonsContent),
          recency: mostRecent,
          sourceIds: relevantLessons.map((l) => l.id),
        });
      }

      const allSessions = await kv.list<Session>(KV.sessions);
      const sessions = allSessions
        .filter((s) => s.project === data.project && s.id !== data.sessionId)
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        )
        .slice(0, 10);

      const summariesPerSession = await Promise.all(
        sessions.map((s) =>
          kv.get<SessionSummary>(KV.summaries, s.id).catch(() => null),
        ),
      );

      const sessionsNeedingObs: number[] = [];
      for (let i = 0; i < sessions.length; i++) {
        const summary = summariesPerSession[i];
        if (summary) {
          const content = `## ${summary.title}\n${summary.narrative}\nDecisions: ${summary.keyDecisions.join("; ")}\nFiles: ${summary.filesModified.join(", ")}`;
          blocks.push({
            type: "summary",
            content,
            tokens: estimateTokens(content),
            recency: new Date(summary.createdAt).getTime(),
          });
        } else {
          sessionsNeedingObs.push(i);
        }
      }

      const obsResults = await Promise.all(
        sessionsNeedingObs.map((i) =>
          kv
            .list<CompressedObservation>(KV.observations(sessions[i]!.id))
            .catch(() => [] as CompressedObservation[]),
        ),
      );

      for (let j = 0; j < sessionsNeedingObs.length; j++) {
        const i = sessionsNeedingObs[j]!;
        const session = sessions[i]!;
        const observations = obsResults[j] ?? [];
        const important = observations.filter(
          (o) => o.title && o.importance >= 5,
        );

        if (important.length > 0) {
          const top = important
            .sort((a, b) => b.importance - a.importance)
            .slice(0, 5);
          const items = top
            .map((o) => `- [${o.type}] ${o.title}: ${o.narrative}`)
            .join("\n");
          const content = `## Session ${session.id.slice(0, 8)} (${session.startedAt})\n${items}`;
          blocks.push({
            type: "observation",
            content,
            tokens: estimateTokens(content),
            recency: new Date(session.startedAt).getTime(),
            sourceIds: top.map((o) => o.id),
          });
        }
      }

      blocks.sort((a, b) => b.recency - a.recency);

      let usedTokens = 0;
      const selected: string[] = [];
      const accessedIds: string[] = [];
      const header = `<the original implementation-context project="${escapeXmlAttr(data.project)}">`;
      const footer = `</memwarden-context>`;
      usedTokens += estimateTokens(header) + estimateTokens(footer);

      for (const block of blocks) {
        if (usedTokens + block.tokens > budget) continue;
        selected.push(block.content);
        usedTokens += block.tokens;
        if (block.sourceIds && block.sourceIds.length > 0) {
          accessedIds.push(...block.sourceIds);
        }
      }

      if (accessedIds.length > 0) {
        void recordAccessBatch(kv, accessedIds);
      }

      if (selected.length === 0) {
        logger.info("No context available", { project: data.project });
        return { context: "", blocks: 0, tokens: 0 };
      }

      const result = `${header}\n${selected.join("\n\n")}\n${footer}`;
      logger.info("Context generated", {
        blocks: selected.length,
        tokens: usedTokens,
      });
      return { context: result, blocks: selected.length, tokens: usedTokens };
    },
  );
}
