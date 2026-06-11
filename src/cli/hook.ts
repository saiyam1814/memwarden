//
// Agent lifecycle hook handlers — the "knows before you ask" path.
//
// Coding agents (Claude Code, Codex, …) run hook commands and pass a JSON
// event on stdin. memwarden wires two:
//
//   SessionStart -> handleSessionStart: pulls this project's recent memory
//      from the daemon and prints it as injected context, so a freshly
//      opened agent already knows what was done here — even by another tool.
//   PostToolUse  -> handleCapture: forwards the tool call/result to the
//      daemon's observe path so memory accrues with zero manual effort.
//
// Both are pure over their (rawStdin, deps): the daemon call is an injected
// fetch and the clock is injected, so they unit-test without a network or a
// live agent.

import {
  isCaptureEnabled,
  isInjectEnabled,
  isProjectExcluded,
} from "../functions/config.js";

export interface HookDeps {
  baseUrl: string;
  secret?: string;
  fetchFn?: typeof fetch;
  now?: () => string;
}

interface HookEvent {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

function headers(deps: HookDeps): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (deps.secret) h["authorization"] = `Bearer ${deps.secret}`;
  return h;
}

function parse(raw: string): HookEvent {
  try {
    return JSON.parse(raw) as HookEvent;
  } catch {
    return {};
  }
}

/**
 * SessionStart: return a Claude-Code-style context injection containing this
 * project's recent memory. Empty string when there is nothing to inject
 * (a brand-new project, or the daemon is down) — a hook that prints nothing
 * is a no-op, never an error.
 */
export async function handleSessionStart(
  raw: string,
  deps: HookDeps,
): Promise<string> {
  const evt = parse(raw);
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
      }),
    });
    if (!res.ok) return "";
    // Narrative-format /search returns the packed block under `text`.
    const data = (await res.json()) as { text?: string };
    const text = data.text ?? "";
    if (!text.trim()) return "";
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "Relevant memory from previous sessions in this project " +
          "(captured by memwarden across all your agents):\n\n" +
          text,
      },
    });
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
  const evt = parse(raw);
  const cwd = evt.cwd ?? process.cwd();
  // An excluded project never reaches the brain (no capture) AND the brain
  // never reaches it (no Déjà Fix injection) — the exclude gates every
  // automatic surface, not just some of them.
  if (isProjectExcluded(cwd)) return "";
  const doFetch = deps.fetchFn ?? fetch;
  const now = deps.now ? deps.now() : new Date().toISOString();
  if (!isCaptureEnabled()) {
    return isInjectEnabled() ? dejaFixInjection(evt, cwd, deps, doFetch) : "";
  }
  try {
    await doFetch(`${deps.baseUrl}/memwarden/observe`, {
      method: "POST",
      headers: headers(deps),
      body: JSON.stringify({
        hookType: "post_tool_use",
        sessionId: evt.session_id ?? "hook",
        project: cwd,
        cwd,
        timestamp: now,
        data: {
          tool_name: evt.tool_name ?? "unknown",
          tool_input: evt.tool_input ?? {},
          tool_output: evt.tool_response ?? "",
        },
      }),
    });
  } catch {
    // swallow — capture is best-effort
  }

  return isInjectEnabled() ? dejaFixInjection(evt, cwd, deps, doFetch) : "";
}

// Cheap client-side gate: only ask the daemon for a fix when the output plausibly
// contains an error, so a clean tool call doesn't cost a second round-trip.
const ERROR_HINT_RE = /\b(error|errno|exception|traceback|failed|failure|panic)\b|[✕✗×]/i;

function outputText(toolResponse: unknown): string {
  if (typeof toolResponse === "string") return toolResponse;
  if (toolResponse == null) return "";
  try {
    return JSON.stringify(toolResponse);
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
  evt: HookEvent,
  cwd: string,
  deps: HookDeps,
  doFetch: typeof fetch,
): Promise<string> {
  const text = outputText(evt.tool_response);
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
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `Déjà Fix (memwarden): this error was solved ${who}${when} ` +
          `and the fix is verified current against your working tree.${cause}\n` +
          `Fix: ${fix.fix}`,
      },
    });
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
