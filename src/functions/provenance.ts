//
// Extract provenance from an observe payload — the evidence trail that
// lets the doctor judge a memory's trustworthiness later. Pure, no I/O.

import type { Provenance } from "./types.js";

const FILE_KEYS = ["file_path", "filePath", "file", "path", "notebook_path"];
// Looks like a path: has a slash or a dotted extension.
const PATH_RE = /(^|\/)[\w.\-/]+\.\w{1,8}$|\//;

function collectFiles(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const obj = toolInput as Record<string, unknown>;
  const files = new Set<string>();
  for (const k of FILE_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) files.add(v.trim());
  }
  // Also catch path-shaped string values in any field (e.g. globs, targets).
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.length < 400 && PATH_RE.test(v) && !v.includes(" ")) {
      files.add(v.trim());
    }
  }
  return Array.from(files);
}

export function extractProvenance(payload: {
  cwd?: string;
  timestamp?: string;
  agent?: string;
  data?: unknown;
}): Provenance {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const toolName = typeof data["tool_name"] === "string" ? data["tool_name"] : undefined;
  const toolInput = data["tool_input"];
  const files = collectFiles(toolInput);

  let command = toolName;
  // For shell tools, capture the actual command for a sharper source.
  if (toolName && toolInput && typeof toolInput === "object") {
    const cmd = (toolInput as Record<string, unknown>)["command"];
    if (typeof cmd === "string" && cmd.trim()) {
      command = `${toolName}: ${cmd.trim().slice(0, 200)}`;
    }
  }

  const prov: Provenance = { userConfirmed: false };
  if (payload.cwd) prov.cwd = payload.cwd;
  if (files.length > 0) prov.files = files;
  if (command) prov.command = command;
  if (payload.agent) prov.agent = payload.agent;
  if (payload.timestamp) prov.capturedAt = payload.timestamp;
  return prov;
}

/** True when a memory has no evidence backing it. */
export function isUnsourced(p: Provenance | undefined): boolean {
  if (!p) return true;
  const hasFiles = Array.isArray(p.files) && p.files.length > 0;
  return !hasFiles && !p.command && !p.userConfirmed;
}
