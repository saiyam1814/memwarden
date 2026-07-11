//
// Agent lifecycle hook handlers — the "knows before you ask" path.
//
// Coding agents (Claude Code, Codex, Cursor, Gemini CLI, Kiro, OpenCode)
// run hook commands and pass a JSON event on stdin. memwarden wires two:
//
//   session start -> handleSessionStart: pulls this project's recent memory
//      from the daemon and prints it as injected context, so a freshly
//      opened agent already knows what was done here — even by another tool.
//   post tool use -> handleCapture: forwards the tool call/result to the
//      daemon's observe path so memory accrues with zero manual effort.
//
// Hosts speak different dialects of the same idea, so both handlers go
// through a canonical event layer: parseHostEvent maps each host's stdin
// JSON onto {sessionId, cwd, toolName, toolInput, toolOutput} and
// formatInjection shapes the reply in that host's expected response schema
// (Claude/Codex hookSpecificOutput vs Cursor additional_context vs Gemini
// additionalContext vs plain stdout for Kiro/OpenCode). Default host is
// claude-code for back-compat.
//
// Both are pure over their (rawStdin, deps): the daemon call is an injected
// fetch and the clock is injected, so they unit-test without a network or a
// live agent.

import {
  isCaptureEnabled,
  isInjectEnabled,
  isProjectExcluded,
} from "../functions/config.js";

// --- canonical event layer -----------------------------------------

/** Agent hosts with a native hook (or plugin) dialect memwarden speaks. */
export const HOOK_HOSTS = [
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "kiro",
  "opencode",
] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];

export function isHookHost(id: string): id is HookHost {
  return (HOOK_HOSTS as readonly string[]).includes(id);
}

/** The host-agnostic shape both handlers operate on. */
export interface CanonicalEvent {
  sessionId?: string;
  cwd?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Map one host's stdin JSON onto the canonical event. Field names verified
 * against each host's hook reference (July 2026):
 *   claude-code / codex / gemini / kiro
 *     {session_id, cwd, tool_name, tool_input, tool_response}
 *   cursor
 *     {session_id|conversation_id, cwd|workspace_roots[0], tool_name,
 *      tool_input, tool_output}   (tool output key differs, cwd is only on
 *      tool events — workspace_roots is the session-level fallback)
 *   opencode
 *     our own plugin sends the canonical field names directly.
 * Malformed JSON yields an empty event — a hook is never the thing that
 * breaks an agent's turn.
 */
export function parseHostEvent(raw: string, host: HookHost): CanonicalEvent {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    obj = {};
  }
  if (host === "opencode") {
    const evt: CanonicalEvent = {};
    const sessionId = str(obj["sessionId"]);
    const cwd = str(obj["cwd"]);
    const toolName = str(obj["toolName"]);
    if (sessionId) evt.sessionId = sessionId;
    if (cwd) evt.cwd = cwd;
    if (toolName) evt.toolName = toolName;
    if ("toolInput" in obj) evt.toolInput = obj["toolInput"];
    if ("toolOutput" in obj) evt.toolOutput = obj["toolOutput"];
    return evt;
  }
  const evt: CanonicalEvent = {};
  const sessionId =
    str(obj["session_id"]) ??
    (host === "cursor" ? str(obj["conversation_id"]) : undefined);
  const roots = obj["workspace_roots"];
  const cwd =
    str(obj["cwd"]) ??
    (host === "cursor" && Array.isArray(roots) ? str(roots[0]) : undefined);
  const toolName = str(obj["tool_name"]);
  if (sessionId) evt.sessionId = sessionId;
  if (cwd) evt.cwd = cwd;
  if (toolName) evt.toolName = toolName;
  if ("tool_input" in obj) evt.toolInput = obj["tool_input"];
  const outputKey = host === "cursor" ? "tool_output" : "tool_response";
  if (outputKey in obj) evt.toolOutput = obj[outputKey];
  return evt;
}

/**
 * Wrap injection text in the response schema the host expects. Empty text
 * always yields "" (print nothing = no-op) regardless of host.
 *   claude-code / codex : {hookSpecificOutput:{hookEventName,additionalContext}}
 *   gemini              : {hookSpecificOutput:{additionalContext}}
 *   cursor              : {additional_context}
 *   kiro / opencode     : plain stdout (Kiro adds agentSpawn stdout to
 *                         context; our OpenCode plugin consumes raw text)
 */
export function formatInjection(
  host: HookHost,
  kind: "session-start" | "capture",
  text: string,
): string {
  if (!text) return "";
  switch (host) {
    case "claude-code":
    case "codex":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: kind === "session-start" ? "SessionStart" : "PostToolUse",
          additionalContext: text,
        },
      });
    case "gemini":
      return JSON.stringify({ hookSpecificOutput: { additionalContext: text } });
    case "cursor":
      return JSON.stringify({ additional_context: text });
    case "kiro":
    case "opencode":
      return text;
  }
}

// --- handlers -------------------------------------------------------

export interface HookDeps {
  baseUrl: string;
  secret?: string;
  /** Which agent host sent this event; shapes parsing, the reply schema,
   * and the liveness heartbeat. Default: claude-code (back-compat). */
  host?: HookHost;
  fetchFn?: typeof fetch;
  now?: () => string;
}

function headers(deps: HookDeps): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (deps.secret) h["authorization"] = `Bearer ${deps.secret}`;
  return h;
}

function hostOf(deps: HookDeps): HookHost {
  return deps.host ?? "claude-code";
}

/**
 * SessionStart: return a host-shaped context injection containing this
 * project's recent memory. Empty string when there is nothing to inject
 * (a brand-new project, or the daemon is down) — a hook that prints nothing
 * is a no-op, never an error.
 */
export async function handleSessionStart(
  raw: string,
  deps: HookDeps,
): Promise<string> {
  const host = hostOf(deps);
  const evt = parseHostEvent(raw, host);
  const cwd = evt.cwd ?? process.cwd();
  // User switches: MEMWARDEN_INJECT=off (clean-slate sessions) and the
  // per-project exclude list both silence auto-injection entirely.
  if (!isInjectEnabled() || isProjectExcluded(cwd)) return "";
  const doFetch = deps.fetchFn ?? fetch;
  try {
    const res = await doFetch(`${deps.baseUrl}/memwarden/search`, {
      method: "POST",
      headers: headers(deps),
      body: JSON.stringify({
        query: "recent work and decisions in this project",
        cwd,
        format: "narrative",
        limit: 20,
        token_budget: 1500,
        safe_only: true, // Verified Recall: SessionStart never injects stale memory
        agent: host, // liveness heartbeat: the daemon records last-seen per host
      }),
    });
    if (!res.ok) return "";
    // Narrative-format /search returns the packed block under `text`.
    const data = (await res.json()) as { text?: string };
    const text = data.text ?? "";
    if (!text.trim()) return "";
    return formatInjection(
      host,
      "session-start",
      "Relevant memory from previous sessions in this project " +
        "(captured by memwarden across all your agents):\n\n" +
        text,
    );
  } catch {
    return "";
  }
}

/**
 * PostToolUse: forward the tool call to the daemon's observe path, and — the
 * Déjà Fix path — if the tool's output looks like an error, ask the daemon
 * whether any agent already solved it and inject the verified fix. Capture is
 * best-effort and failures are swallowed so a downed daemon never breaks the
 * agent's turn. Returns the Déjà Fix injection (or "" when there's nothing
 * verified to surface).
 */
export async function handleCapture(
  raw: string,
  deps: HookDeps,
): Promise<string> {
  const host = hostOf(deps);
  const evt = parseHostEvent(raw, host);
  const cwd = evt.cwd ?? process.cwd();
  // An excluded project never reaches the brain (no capture) AND the brain
  // never reaches it (no Déjà Fix injection) — the exclude gates every
  // automatic surface, not just some of them.
  if (isProjectExcluded(cwd)) return "";
  const doFetch = deps.fetchFn ?? fetch;
  const now = deps.now ? deps.now() : new Date().toISOString();
  if (!isCaptureEnabled()) {
    return isInjectEnabled() ? dejaFixInjection(evt, cwd, host, deps, doFetch) : "";
  }
  try {
    await doFetch(`${deps.baseUrl}/memwarden/observe`, {
      method: "POST",
      headers: headers(deps),
      body: JSON.stringify({
        hookType: "post_tool_use",
        sessionId: evt.sessionId ?? "hook",
        project: cwd,
        cwd,
        timestamp: now,
        agent: host, // provenance + liveness heartbeat
        data: {
          tool_name: evt.toolName ?? "unknown",
          tool_input: evt.toolInput ?? {},
          tool_output: evt.toolOutput ?? "",
        },
      }),
    });
  } catch {
    // swallow — capture is best-effort
  }

  return isInjectEnabled() ? dejaFixInjection(evt, cwd, host, deps, doFetch) : "";
}

// Cheap client-side gate: only ask the daemon for a fix when the output plausibly
// contains an error, so a clean tool call doesn't cost a second round-trip.
const ERROR_HINT_RE = /\b(error|errno|exception|traceback|failed|failure|panic)\b|[✕✗×]/i;

function outputText(toolOutput: unknown): string {
  if (typeof toolOutput === "string") return toolOutput;
  if (toolOutput == null) return "";
  try {
    return JSON.stringify(toolOutput);
  } catch {
    return "";
  }
}

/**
 * If the tool output looks like an error, look it up in Déjà Fix. Inject ONLY
 * a "verified current" fix (every referenced file still hash-matches) — the
 * conservative, trustworthy default; sourced-but-unverified fixes stay
 * available via /recall and the dejafix tools but are never auto-injected.
 */
async function dejaFixInjection(
  evt: CanonicalEvent,
  cwd: string,
  host: HookHost,
  deps: HookDeps,
  doFetch: typeof fetch,
): Promise<string> {
  const text = outputText(evt.toolOutput);
  if (!text.trim() || !ERROR_HINT_RE.test(text)) return "";
  try {
    const res = await doFetch(`${deps.baseUrl}/memwarden/dejafix/lookup`, {
      method: "POST",
      headers: headers(deps),
      body: JSON.stringify({ error_text: text, cwd }),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as {
      fixes?: Array<{
        fix?: string;
        rootCause?: string;
        tool?: string;
        timestamp?: string;
        status?: string;
      }>;
    };
    const fix = (data.fixes ?? []).find((f) => f.status === "verified" && f.fix);
    if (!fix || !fix.fix) return "";
    const who = fix.tool ? `by ${fix.tool}` : "earlier";
    const when = fix.timestamp ? ` on ${fix.timestamp.slice(0, 10)}` : "";
    const cause = fix.rootCause ? `\nRoot cause: ${fix.rootCause}` : "";
    return formatInjection(
      host,
      "capture",
      `Déjà Fix (memwarden): this error was solved ${who}${when} ` +
        `and the fix is verified current against your working tree.${cause}\n` +
        `Fix: ${fix.fix}`,
    );
  } catch {
    return "";
  }
}

/** Read all of stdin as a string. */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    // If nothing is piped, don't hang forever.
    if (process.stdin.isTTY) resolve("");
  });
}
