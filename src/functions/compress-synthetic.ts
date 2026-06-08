//
// Zero-LLM compression: turn a RawObservation into a CompressedObservation
// with heuristics only (no model call, no token spend). This is the default
// observe path until an LLM provider is wired in. It classifies the tool,
// pulls out any file paths, and builds a short narrative.

import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
} from "./types.js";

// tool-name keyword -> observation type, in priority order
const TOOL_KINDS: ReadonlyArray<readonly [ObservationType, readonly string[]]> = [
  ["web_fetch", ["fetch", "http", "web"]],
  ["search", ["grep", "search", "glob", "find"]],
  ["command_run", ["bash", "shell", "exec", "run"]],
  ["file_edit", ["edit", "update", "patch", "replace"]],
  ["file_write", ["write", "create"]],
  ["file_read", ["read", "view"]],
  ["subagent", ["task", "agent"]],
];

const FILE_KEYS = ["file_path", "filepath", "path", "filePath", "file", "pattern"];

// split camelCase / kebab / spaces into a normalized underscore form
function normalizeToolName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function mentions(normalized: string, word: string): boolean {
  return (
    new RegExp(`(^|_)${word}(_|$)`).test(normalized) ||
    normalized === word ||
    normalized.startsWith(word) ||
    normalized.endsWith(word)
  );
}

function classify(toolName: string | undefined, hookType: string): ObservationType {
  if (hookType === "post_tool_failure") return "error";
  if (hookType === "prompt_submit") return "conversation";
  if (hookType === "subagent_stop" || hookType === "task_completed") return "subagent";
  if (hookType === "notification") return "notification";
  if (!toolName) return "other";
  const n = normalizeToolName(toolName);
  for (const [kind, words] of TOOL_KINDS) {
    if (words.some((w) => mentions(n, w))) return kind;
  }
  return "other";
}

function filePaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const found = new Set<string>();
  for (const key of FILE_KEYS) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0 && v.length < 512) found.add(v);
  }
  return [...found];
}

function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function buildSyntheticCompression(raw: RawObservation): CompressedObservation {
  const toolName = raw.toolName ?? raw.hookType;
  const inputText = asText(raw.toolInput);
  const outputText = asText(raw.toolOutput);
  const narrative = [raw.userPrompt ?? "", inputText, outputText]
    .filter((s) => s.length > 0)
    .join(" | ");

  const result: CompressedObservation = {
    id: raw.id,
    sessionId: raw.sessionId,
    timestamp: raw.timestamp,
    type: classify(toolName, raw.hookType),
    title: clip(toolName || "observation", 80),
    facts: [],
    narrative: clip(narrative, 400),
    concepts: [],
    files: filePaths(raw.toolInput),
    importance: 5,
    confidence: 0.3,
  };
  if (inputText) result.subtitle = clip(inputText, 120);
  if (raw.modality) result.modality = raw.modality;
  if (raw.imageData) result.imageData = raw.imageData;
  if (raw.agentId) result.agentId = raw.agentId;
  return result;
}
