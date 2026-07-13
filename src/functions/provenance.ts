//
// Extract provenance from an observe payload — the evidence trail that
// lets the doctor judge a memory's trustworthiness later. Pure, no I/O.

import { isAbsolute, relative, sep } from "node:path";
import type { Provenance } from "./types.js";

// Keys whose string values are treated as file references wherever they
// appear in tool_input (hosts nest them: Kiro fsReplace uses
// tool_input.operations[].path, patch tools wrap changes[].file_path, …).
const FILE_KEYS = [
  "file_path",
  "filePath",
  "file",
  "path",
  "notebook_path",
  "notebookPath",
];
// Looks like a path: has a slash or a dotted extension.
const PATH_RE = /(^|\/)[\w.\-/]+\.\w{1,8}$|\//;
// Bounded, best-effort extraction: hosts can nest arbitrarily deep and wide;
// provenance only needs the referenced files, not a full input walk.
//
// TRUNCATION IS NOT SILENT: a memory whose evidence was capped references
// files its provenance cannot vouch for, so the caller marks it mixedTrust —
// verification of the captured subset must never certify the whole memory
// as `verified` (drift in an uncaptured file would go undetected).
const MAX_FILE_DEPTH = 4;
const MAX_FILES = 64;

export function collectFilesBounded(toolInput: unknown): {
  files: string[];
  truncated: boolean;
} {
  const files = new Set<string>();
  let truncated = false;
  // Collect one PAST the cap so hitting the cap is distinguishable from
  // exactly filling it.
  const limit = MAX_FILES + 1;
  const visit = (node: unknown, depth: number): void => {
    if (files.size >= limit) return;
    if (!node || typeof node !== "object") return;
    if (depth > MAX_FILE_DEPTH) {
      // An unvisited object below the depth cap could hold file keys we
      // never saw — same falsely-complete-evidence hazard as the size cap.
      truncated = true;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (files.size >= limit) return;
        visit(item, depth + 1);
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const k of FILE_KEYS) {
      const v = obj[k];
      if (typeof v === "string" && v.trim() && files.size < limit) {
        files.add(v.trim());
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        // Also catch path-shaped string values in any TOP-LEVEL field (e.g.
        // globs, targets) — the pre-recursion behavior, kept verbatim so
        // shallow hosts extract exactly what they always did. Nested levels
        // only trust the explicit FILE_KEYS above, so arbitrary nested prose
        // containing a "/" is not misread as a file reference.
        if (
          depth === 0 &&
          !FILE_KEYS.includes(k) &&
          v.length < 400 &&
          PATH_RE.test(v) &&
          !v.includes(" ") &&
          files.size < limit
        ) {
          files.add(v.trim());
        }
      } else {
        visit(v, depth + 1);
      }
    }
  };
  visit(toolInput, 0);
  const all = Array.from(files);
  if (all.length > MAX_FILES) truncated = true;
  return { files: all.slice(0, MAX_FILES), truncated };
}

/**
 * Give a captured file its portable identity: a file UNDER the capture cwd is
 * stored repo-relative, so Verified Recall from another checkout of the same
 * project (worktree, moved clone) re-roots it correctly. Files outside the
 * cwd keep their absolute path — re-rooting those would point a cross-project
 * memory at the wrong repo. Pure string logic, no fs.
 */
export function relativizeUnder(cwd: string | undefined, file: string): string {
  if (!cwd || !isAbsolute(cwd) || !isAbsolute(file)) return file;
  const rel = relative(cwd, file);
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    return file;
  }
  return rel;
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
  const collected = collectFilesBounded(toolInput);
  const files = Array.from(
    new Set(collected.files.map((f) => relativizeUnder(payload.cwd, f))),
  );

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
  // Capped evidence: the memory references files this provenance does not
  // carry, so hashes over the captured subset can never certify the whole
  // memory (classifyProvenance caps mixedTrust below `verified`).
  if (collected.truncated) prov.mixedTrust = true;
  return prov;
}

/** True when a memory has no evidence backing it. */
export function isUnsourced(p: Provenance | undefined): boolean {
  if (!p) return true;
  const hasFiles = Array.isArray(p.files) && p.files.length > 0;
  return !hasFiles && !p.command && !p.userConfirmed;
}
