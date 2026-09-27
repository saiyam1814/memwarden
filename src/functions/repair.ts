//
// Repair for memories distilled from pre-0.0.8 captures. The old extractor
// titled every capture with its TOOL NAME and stored the raw tool input and
// output JSON as the body, with facts and concepts empty. The durability
// contract (forget.ts) later PROMOTED those observations into permanent
// memories at the retention TTL, so on one real brain 4,064 of 7,532
// memories (54%) were rows like
//
//   title: "exec"   content: {"command":"git status"} | {"success":true,…}
//
// which rank on JSON tokens and read as noise. This module brings each one to
// what today's pipeline would have produced: re-extracted, and re-distilled
// through the standard path (distillMembers) when it holds knowledge its
// files do not (a change, an error, a fact), so the successor gets correct
// claim/evidence fingerprints and keeps the original provenance, file hashes,
// sessions, and timestamps. Plain reads, which today's retention ages out,
// are retired instead. Either way the legacy row goes through mem::forget,
// with its receipt.
// Nothing is invented: the successor is built only from what the legacy row
// already stored.

import type { ISdk } from "../kernel/index.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { CompressedObservation, Memory, RawObservation, Session } from "./types.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { distillMembers } from "./consolidate.js";
import { worthDistilling } from "./forget.js";
import { resolveMemoryIdentity } from "./memory-identity.js";
import { logger } from "./logger.js";

/** A single token with no spaces or dots: how a tool name looks as a title. */
const BARE_TITLE = /^[A-Za-z_][\w:-]*$/;

/**
 * The legacy shape, and only that shape: tool-name title, no facts, no
 * concepts, and a body that is serialized JSON. Manual memories are never
 * candidates, whatever they look like.
 */
export function isLegacyJunkMemory(m: Memory): boolean {
  if (m.origin === "manual") return false;
  if (!BARE_TITLE.test(m.title ?? "")) return false;
  if ((m.facts?.length ?? 0) > 0 || (m.concepts?.length ?? 0) > 0) return false;
  const c = (m.content ?? "").trim();
  return c.startsWith("{") || c.startsWith("[") || /[}\]] \| [{["]/.test(c);
}

// Input keys worth recovering from a truncated JSON body, in the order the
// extractor looks at them.
const RECOVERABLE_KEYS = [
  "command", "file_path", "filePath", "path", "pattern", "url", "query",
  "old_string", "new_string", "description", "prompt",
];

/** Pull `"key":"value"` pairs out of JSON that was clipped mid-object. */
function lenientInput(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const key of RECOVERABLE_KEYS) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
    if (!m) continue;
    try {
      out[key] = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      out[key] = m[1]!;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Split a legacy `input | output` body back into its two halves. */
export function splitLegacyBody(content: string): { input: unknown; output: unknown } | null {
  let idx = content.indexOf(" | ");
  while (idx !== -1) {
    const left = content.slice(0, idx);
    try {
      const input = JSON.parse(left) as unknown;
      const rest = content.slice(idx + 3);
      let output: unknown = rest;
      try {
        output = JSON.parse(rest);
      } catch {
        // clipped output stays text; summarizeOutput decides what is readable
      }
      return { input, output };
    } catch {
      idx = content.indexOf(" | ", idx + 1);
    }
  }
  try {
    return { input: JSON.parse(content), output: "" };
  } catch {
    const input = lenientInput(content);
    return input ? { input, output: "" } : null;
  }
}

/** The observation a legacy memory would have been, re-extracted today. */
export function reextractLegacyMemory(m: Memory): CompressedObservation | null {
  const body = splitLegacyBody(m.content);
  if (!body) return null;
  const sourceId = m.sourceObservationIds?.[0] ?? m.supersedes?.[0] ?? m.id;
  const raw: RawObservation = {
    id: sourceId,
    sessionId: m.sessionIds[0] ?? "legacy",
    timestamp: m.createdAt,
    hookType: "post_tool_use",
    raw: {},
    toolName: m.title,
    toolInput: body.input,
    toolOutput: body.output,
  };
  const obs = buildSyntheticCompression(raw);
  if (obs.title === m.title) return null; // nothing better to say
  // Evidence is the legacy row's own, never recomputed: its hashes are the
  // capture-time commitments, and re-hashing today would forge a verdict.
  if (m.provenance) obs.provenance = m.provenance;
  if (m.agentId) obs.agentId = m.agentId;
  const files = Array.from(new Set([...(obs.files ?? []), ...(m.files ?? [])]));
  obs.files = files;
  return obs;
}

export interface RepairReport {
  scanned: number;
  legacy: number;
  /** Re-extracted into a readable successor (edits, writes, errors, facts). */
  repaired: number;
  /** Plain reads the retention policy would never have kept: forgotten. */
  retired: number;
  unrecoverable: number;
  failed: number;
  applied: boolean;
  samples: Array<{ id: string; before: string; after: string }>;
}

export function registerRepairFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::repair-legacy",
    async (data: { apply?: boolean; limit?: number }): Promise<RepairReport> => {
      const apply = data?.apply === true;
      const limit =
        typeof data?.limit === "number" && data.limit > 0 ? Math.floor(data.limit) : Infinity;
      const memories = await kv.list<Memory>(KV.memories);
      const sessions = await kv.list<Session>(KV.sessions).catch(() => [] as Session[]);
      const sessionsById = new Map(sessions.map((s) => [s.id, s]));
      const report: RepairReport = {
        scanned: memories.length,
        legacy: 0,
        repaired: 0,
        retired: 0,
        unrecoverable: 0,
        failed: 0,
        applied: apply,
        samples: [],
      };
      for (const memory of memories) {
        if (!isLegacyJunkMemory(memory)) continue;
        report.legacy++;
        if (report.repaired + report.retired + report.failed >= limit) continue;
        const obs = reextractLegacyMemory(memory);
        if (!obs) {
          report.unrecoverable++;
          continue;
        }
        // A plain read is not knowledge its file lacks: today's retention
        // policy ages those out rather than keeping them (worthDistilling),
        // so repair retires them instead of re-creating them.
        if (!worthDistilling(obs)) {
          if (!apply) {
            report.retired++;
            continue;
          }
          const forgot = await sdk
            .trigger<{ observationId: string }, { deleted?: boolean }>({
              function_id: "mem::forget",
              payload: { observationId: memory.id },
            })
            .catch(() => null);
          if (forgot?.deleted) report.retired++;
          else report.failed++;
          continue;
        }
        if (report.samples.length < 8) {
          report.samples.push({ id: memory.id, before: memory.title, after: obs.title });
        }
        if (!apply) {
          report.repaired++;
          continue;
        }
        try {
          const identity = resolveMemoryIdentity(memory, sessionsById);
          const projectIdentity =
            identity.projectKey || identity.projectPath || identity.captureCwd || "_";
          const primaryFile =
            obs.provenance?.files?.find((f) => f && f.trim()) ??
            obs.files?.find((f) => f && f.trim()) ??
            memory.id;
          const distilled = await distillMembers(kv, {
            projectIdentity,
            primaryFile,
            members: [{ sessionId: obs.sessionId, obs, ...identity }],
            now: Date.parse(memory.updatedAt) || Date.now(),
          });
          if (!distilled || distilled.memId === memory.id) {
            report.failed++;
            continue;
          }
          const forgot = await sdk.trigger<
            { observationId: string },
            { deleted?: boolean }
          >({ function_id: "mem::forget", payload: { observationId: memory.id } });
          if (forgot?.deleted) report.repaired++;
          else report.failed++;
        } catch (err) {
          report.failed++;
          logger.warn("repair-legacy: failed to repair memory", {
            memId: memory.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (apply) logger.info("repair-legacy: done", { ...report, samples: undefined });
      return report;
    },
  );
}
