//
// Recency-packed context assembly (mem::context). Gathers pinned slots, the
// project profile, ranked lessons, and recent same-project sessions (rendered
// from their summary, or from important observations when there is none),
// sorts the blocks newest-first, and greedily packs them under a token budget
// inside a <memwarden-context project="..."> wrapper. Returns
// {context, blocks, tokens}.
//
// Memory slots are an optional, off-by-default feature; when disabled the
// pinned-slots block is empty.

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
import { metrics, estimateTokens } from "../observability/metrics.js";

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function block(
  type: ContextBlock["type"],
  content: string,
  recency: number,
  sourceIds?: string[],
): ContextBlock {
  const b: ContextBlock = { type, content, tokens: estimateTokens(content), recency };
  if (sourceIds && sourceIds.length > 0) b.sourceIds = sourceIds;
  return b;
}

// Slots feature is not part of the core path; no pinned content when disabled.
async function renderPinnedSlots(_kv: StateKV): Promise<string> {
  return isSlotsEnabled() ? "" : "";
}

function profileBlock(profile: ProjectProfile | null): ContextBlock | null {
  if (!profile) return null;
  const parts: string[] = [];
  if (profile.topConcepts.length > 0) {
    parts.push(`Concepts: ${profile.topConcepts.slice(0, 8).map((c) => c.concept).join(", ")}`);
  }
  if (profile.topFiles.length > 0) {
    parts.push(`Key files: ${profile.topFiles.slice(0, 5).map((f) => f.file).join(", ")}`);
  }
  if (profile.conventions.length > 0) {
    parts.push(`Conventions: ${profile.conventions.join("; ")}`);
  }
  if (profile.commonErrors.length > 0) {
    parts.push(`Common errors: ${profile.commonErrors.slice(0, 3).join("; ")}`);
  }
  if (parts.length === 0) return null;
  return block("memory", `## Project Profile\n${parts.join("\n")}`, new Date(profile.updatedAt).getTime());
}

function lessonsBlock(lessons: Lesson[], project: string): ContextBlock | null {
  const relevant = lessons
    .filter((l) => !l.deleted && (!l.project || l.project === project))
    .sort((a, b) => {
      const sa = (a.project === project ? 1.5 : 1) * a.confidence;
      const sb = (b.project === project ? 1.5 : 1) * b.confidence;
      return sb - sa;
    })
    .slice(0, 10);
  if (relevant.length === 0) return null;
  const items = relevant
    .map((l) => `- (${l.confidence.toFixed(2)}) ${l.content}${l.context ? ` — ${l.context}` : ""}`)
    .join("\n");
  const recency = relevant.reduce((acc, l) => {
    const t = new Date(l.lastReinforcedAt || l.updatedAt).getTime();
    return t > acc ? t : acc;
  }, 0);
  return block("memory", `## Lessons Learned\n${items}`, recency, relevant.map((l) => l.id));
}

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction(
    "mem::context",
    async (data: { sessionId: string; project: string; budget?: number }) => {
      const startedAt = performance.now();
      const budget = data.budget || tokenBudget;
      const blocks: ContextBlock[] = [];

      const [slotContent, profile, lessons] = await Promise.all([
        renderPinnedSlots(kv).catch(() => ""),
        kv.get<ProjectProfile>(KV.profiles, data.project).catch(() => null),
        kv.list<Lesson>(KV.lessons).catch(() => [] as Lesson[]),
      ]);

      if (slotContent) blocks.push(block("memory", slotContent, Date.now()));
      const pb = profileBlock(profile);
      if (pb) blocks.push(pb);
      const lb = lessonsBlock(lessons, data.project);
      if (lb) blocks.push(lb);

      // Recent sessions in the same project (excluding the current one).
      const sessions = (await kv.list<Session>(KV.sessions))
        .filter((s) => s.project === data.project && s.id !== data.sessionId)
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
        .slice(0, 10);

      const summaries = await Promise.all(
        sessions.map((s) => kv.get<SessionSummary>(KV.summaries, s.id).catch(() => null)),
      );

      // A session renders from its summary, or falls back to its important
      // observations when no summary exists.
      const needObs: number[] = [];
      sessions.forEach((_, i) => {
        const summary = summaries[i];
        if (summary) {
          const content = `## ${summary.title}\n${summary.narrative}\nDecisions: ${summary.keyDecisions.join("; ")}\nFiles: ${summary.filesModified.join(", ")}`;
          blocks.push(block("summary", content, new Date(summary.createdAt).getTime()));
        } else {
          needObs.push(i);
        }
      });

      const obsLists = await Promise.all(
        needObs.map((i) =>
          kv
            .list<CompressedObservation>(KV.observations(sessions[i]!.id))
            .catch(() => [] as CompressedObservation[]),
        ),
      );

      needObs.forEach((sessionIdx, j) => {
        const session = sessions[sessionIdx]!;
        const important = (obsLists[j] ?? []).filter((o) => o.title && o.importance >= 5);
        if (important.length === 0) return;
        const top = important.sort((a, b) => b.importance - a.importance).slice(0, 5);
        const items = top.map((o) => `- [${o.type}] ${o.title}: ${o.narrative}`).join("\n");
        const content = `## Session ${session.id.slice(0, 8)} (${session.startedAt})\n${items}`;
        blocks.push(
          block("observation", content, new Date(session.startedAt).getTime(), top.map((o) => o.id)),
        );
      });

      // Newest first, then greedily pack under the budget.
      blocks.sort((a, b) => b.recency - a.recency);
      const candidateTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);

      const header = `<memwarden-context project="${escapeXmlAttr(data.project)}">`;
      const footer = `</memwarden-context>`;
      let usedTokens = estimateTokens(header) + estimateTokens(footer);
      const selected: string[] = [];
      const accessedIds: string[] = [];
      for (const b of blocks) {
        if (usedTokens + b.tokens > budget) continue;
        selected.push(b.content);
        usedTokens += b.tokens;
        if (b.sourceIds) accessedIds.push(...b.sourceIds);
      }

      if (accessedIds.length > 0) void recordAccessBatch(kv, accessedIds);

      const elapsed = performance.now() - startedAt;
      if (selected.length === 0) {
        metrics.recordContext(candidateTokens, 0, elapsed);
        logger.info("No context available", { project: data.project });
        return { context: "", blocks: 0, tokens: 0 };
      }

      metrics.recordContext(candidateTokens, usedTokens, elapsed);
      logger.info("Context generated", { blocks: selected.length, tokens: usedTokens });
      return {
        context: `${header}\n${selected.join("\n\n")}\n${footer}`,
        blocks: selected.length,
        tokens: usedTokens,
      };
    },
  );
}
