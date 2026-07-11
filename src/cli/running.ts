//
// Which wired tools are running RIGHT NOW? `up` uses this to turn the vague
// "restart each tool once" advice into a per-tool truth: a CLI agent picks
// the new hooks up on its next session automatically (nothing to do unless a
// session is open this second), while a long-lived GUI app genuinely needs a
// restart. memwarden never restarts anything itself — killing a user's live
// agent session to load a config is a worse failure than the one it fixes.

import { execFileSync } from "node:child_process";

// Process-name fragments per tool id, matched against lowercased basenames
// from `ps`. Deliberately loose: "cursor" also matches "Cursor Helper".
const TOOL_PROCESS_PATTERNS: Record<string, string[]> = {
  "claude-code": ["claude"],
  codex: ["codex"],
  cursor: ["cursor"],
  kiro: ["kiro"],
  antigravity: ["antigravity"],
  gemini: ["gemini"],
  opencode: ["opencode"],
  openclaw: ["openclaw"],
};

// Tools that are long-lived GUI apps: hooks load at app start, so a running
// instance needs a real restart. Everything else is session-per-invocation.
const GUI_TOOLS = new Set(["cursor", "kiro", "antigravity"]);

/**
 * Lowercased process basenames currently running, or null when the platform
 * gives us no cheap way to look (win32) — callers must treat null as
 * "unknown", never as "not running".
 */
export function runningProcessNames(): Set<string> | null {
  if (process.platform === "win32") return null;
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "comm="], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const line of out.split("\n")) {
    const comm = line.trim();
    if (!comm) continue;
    const base = comm.split("/").pop() ?? comm;
    names.add(base.toLowerCase());
  }
  return names;
}

/** Pure matcher, unit-testable without a live process table. */
export function matchesTool(toolId: string, processNames: Set<string>): boolean {
  const patterns = TOOL_PROCESS_PATTERNS[toolId];
  if (!patterns) return false;
  for (const name of processNames) {
    for (const p of patterns) {
      if (name.includes(p)) return true;
    }
  }
  return false;
}

export type RunState = "running" | "not running" | "unknown";

export function toolRunState(
  toolId: string,
  processNames: Set<string> | null,
): RunState {
  if (processNames === null) return "unknown";
  return matchesTool(toolId, processNames) ? "running" : "not running";
}

/**
 * The per-tool restart truth for `up`'s summary:
 *  - GUI app + running   -> "restart it to load the new hooks"
 *  - CLI tool + running  -> "open sessions keep the old config; new ones are wired"
 *  - not running         -> "nothing to do — next session picks it up"
 */
export function restartAdvice(toolId: string, state: RunState): string {
  const gui = GUI_TOOLS.has(toolId);
  if (state === "running") {
    return gui
      ? "running now — restart it to load the new hooks"
      : "session open now — it keeps the old config; your NEXT session is wired";
  }
  if (state === "not running") return "nothing to do — next session picks it up";
  return "could not check running processes — restart it once if hooks stay silent";
}
