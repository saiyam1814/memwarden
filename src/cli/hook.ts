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
 * PostToolUse: forward the tool call to the daemon's observe path. Returns
 * empty string — capture hooks inject nothing. Failures are swallowed so a
 * downed daemon never breaks the agent's turn.
 */
export async function handleCapture(
  raw: string,
  deps: HookDeps,
): Promise<string> {
  const evt = parse(raw);
  const cwd = evt.cwd ?? process.cwd();
  const doFetch = deps.fetchFn ?? fetch;
  const now = deps.now ? deps.now() : new Date().toISOString();
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
  return "";
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
