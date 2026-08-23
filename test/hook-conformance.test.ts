//
// Adapter conformance suite: EVERY host × EVERY event (session-start,
// prompt, capture, session-end) runs a realistic fixture — mirroring that
// host's documented stdin dialect — through the REAL hook handler with a
// mocked daemon fetch, and asserts three things:
//   1. the canonical fields were extracted (sessionId, cwd, tool trio /
//      prompt / reason land in the daemon call),
//   2. the API call shape (endpoint, hookType, agent heartbeat),
//   3. the host-correct response schema (or the empty no-op).
// A host renaming a field or response key breaks a row here, not a user's
// session. Field provenance: claude-code / cursor / gemini shapes verified
// against the July 2026 docs; codex / kiro assumed Claude-style (see
// parseHostEvent).

import { describe, expect, it, vi } from "vitest";
import {
  handleSessionStart,
  handleCapture,
  handlePrompt,
  handleSessionEnd,
  HOOK_HOSTS,
  type HookHost,
} from "../src/cli/hook.js";

const MEM = "the daemon remembered THIS";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

/** Mock daemon: /search returns memory text, everything else acks. */
function mockDaemon() {
  return vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/memwarden/search")) {
      return jsonResponse({ text: MEM });
    }
    return jsonResponse({ observationId: "obs_c" });
  }) as unknown as typeof fetch;
}

function calls(fetchFn: unknown): Array<{ url: string; body: Record<string, unknown> }> {
  return (fetchFn as { mock: { calls: unknown[][] } }).mock.calls.map((c) => ({
    url: c[0] as string,
    body: JSON.parse((c[1] as { body: string }).body),
  }));
}

interface HostFixtures {
  sessionStart: Record<string, unknown>;
  prompt: Record<string, unknown>;
  capture: Record<string, unknown>;
  sessionEnd: Record<string, unknown>;
  /** What the canonical layer must extract from the fixtures. */
  want: { sessionId: string; cwd: string; reason: string };
}

const PROMPT_TEXT = "add retries to the uploader";

const FIXTURES: Record<HookHost, HostFixtures> = {
  "claude-code": {
    sessionStart: {
      session_id: "cc-1",
      transcript_path: "/t.jsonl",
      cwd: "/w/cc",
      hook_event_name: "SessionStart",
      source: "startup",
    },
    prompt: {
      session_id: "cc-1",
      transcript_path: "/t.jsonl",
      cwd: "/w/cc",
      permission_mode: "default",
      hook_event_name: "UserPromptSubmit",
      prompt: PROMPT_TEXT,
    },
    capture: {
      session_id: "cc-1",
      cwd: "/w/cc",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "ok",
    },
    sessionEnd: {
      session_id: "cc-1",
      cwd: "/w/cc",
      hook_event_name: "SessionEnd",
      reason: "prompt_input_exit",
    },
    want: { sessionId: "cc-1", cwd: "/w/cc", reason: "prompt_input_exit" },
  },
  codex: {
    // Claude-style schema (assumed for prompt/stop payload fields).
    sessionStart: { session_id: "cx-1", cwd: "/w/cx", hook_event_name: "SessionStart" },
    prompt: { session_id: "cx-1", cwd: "/w/cx", hook_event_name: "UserPromptSubmit", prompt: PROMPT_TEXT },
    capture: {
      session_id: "cx-1",
      cwd: "/w/cx",
      tool_name: "shell",
      tool_input: { command: "ls" },
      tool_response: "ok",
    },
    sessionEnd: { session_id: "cx-1", cwd: "/w/cx", hook_event_name: "Stop" },
    want: { sessionId: "cx-1", cwd: "/w/cx", reason: "unknown" },
  },
  cursor: {
    sessionStart: {
      conversation_id: "cu-1",
      hook_event_name: "sessionStart",
      workspace_roots: ["/w/cu"],
    },
    prompt: {
      conversation_id: "cu-1",
      hook_event_name: "beforeSubmitPrompt",
      workspace_roots: ["/w/cu"],
      prompt: PROMPT_TEXT,
      attachments: [],
    },
    capture: {
      conversation_id: "cu-1",
      cwd: "/w/cu",
      hook_event_name: "postToolUse",
      tool_name: "Shell",
      tool_input: { command: "ls" },
      tool_output: "ok",
    },
    sessionEnd: {
      session_id: "cu-1",
      reason: "completed",
      duration_ms: 60000,
      workspace_roots: ["/w/cu"],
    },
    want: { sessionId: "cu-1", cwd: "/w/cu", reason: "completed" },
  },
  gemini: {
    sessionStart: { session_id: "ge-1", cwd: "/w/ge", hook_event_name: "SessionStart", source: "startup" },
    prompt: { session_id: "ge-1", cwd: "/w/ge", hook_event_name: "BeforeAgent", prompt: PROMPT_TEXT },
    capture: {
      session_id: "ge-1",
      cwd: "/w/ge",
      hook_event_name: "AfterTool",
      tool_name: "run_shell_command",
      tool_input: { command: "ls" },
      tool_response: "ok",
    },
    sessionEnd: { session_id: "ge-1", cwd: "/w/ge", hook_event_name: "SessionEnd", reason: "exit" },
    want: { sessionId: "ge-1", cwd: "/w/ge", reason: "exit" },
  },
  kiro: {
    // Claude-style schema (assumed for prompt/stop payload fields).
    sessionStart: { session_id: "ki-1", cwd: "/w/ki", hook_event_name: "agentSpawn" },
    prompt: { session_id: "ki-1", cwd: "/w/ki", hook_event_name: "userPromptSubmit", prompt: PROMPT_TEXT },
    capture: {
      session_id: "ki-1",
      cwd: "/w/ki",
      tool_name: "execute_bash",
      tool_input: { command: "ls" },
      tool_response: "ok",
    },
    sessionEnd: { session_id: "ki-1", cwd: "/w/ki", hook_event_name: "stop" },
    want: { sessionId: "ki-1", cwd: "/w/ki", reason: "unknown" },
  },
  grok: {
    // Grok's runner emits camelCase natively (verified: documented stdin
    // example + key set in the grok binary). cwd arrives as `cwd`, with
    // `workspaceRoot` alongside it; tool output is `toolResult`.
    sessionStart: {
      hookEventName: "session_start",
      sessionId: "gk-1",
      cwd: "/w/gk",
      workspaceRoot: "/w/gk",
    },
    prompt: {
      hookEventName: "user_prompt_submit",
      sessionId: "gk-1",
      cwd: "/w/gk",
      prompt: PROMPT_TEXT,
    },
    capture: {
      hookEventName: "post_tool_use",
      sessionId: "gk-1",
      cwd: "/w/gk",
      toolName: "run_terminal_cmd",
      toolInput: { command: "ls" },
      toolResult: "ok",
    },
    sessionEnd: {
      hookEventName: "session_end",
      sessionId: "gk-1",
      cwd: "/w/gk",
      reason: "exit",
    },
    want: { sessionId: "gk-1", cwd: "/w/gk", reason: "exit" },
  },
  opencode: {
    // Our own plugin speaks the canonical field names.
    sessionStart: { sessionId: "oc-1", cwd: "/w/oc" },
    prompt: { sessionId: "oc-1", cwd: "/w/oc", prompt: PROMPT_TEXT },
    capture: {
      sessionId: "oc-1",
      cwd: "/w/oc",
      toolName: "bash",
      toolInput: { cmd: "ls" },
      toolOutput: "ok",
    },
    sessionEnd: { sessionId: "oc-1", cwd: "/w/oc", reason: "idle" },
    want: { sessionId: "oc-1", cwd: "/w/oc", reason: "idle" },
  },
};

/** Host-correct response schema checks for the two injecting/replying events. */
function checkSessionStartResponse(host: HookHost, out: string): void {
  switch (host) {
    case "claude-code":
    case "codex": {
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(parsed.hookSpecificOutput.additionalContext).toContain(MEM);
      break;
    }
    case "gemini": {
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.hookEventName).toBeUndefined();
      expect(parsed.hookSpecificOutput.additionalContext).toContain(MEM);
      break;
    }
    case "cursor": {
      const parsed = JSON.parse(out);
      expect(Object.keys(parsed)).toEqual(["additional_context"]);
      expect(parsed.additional_context).toContain(MEM);
      break;
    }
    case "grok":
      // Grok ignores hook stdout outside PreToolUse, so there is NO injection
      // channel: it captures via hooks and recalls via MCP / AGENTS.md. Emit
      // nothing rather than a payload Grok would silently drop.
      expect(out).toBe("");
      break;
    case "kiro":
    case "opencode":
      // stdout IS the context: plain text, not JSON
      expect(out).toContain(MEM);
      expect(() => JSON.parse(out)).toThrow();
      break;
  }
}

function checkPromptResponse(host: HookHost, out: string): void {
  if (host === "cursor") {
    expect(JSON.parse(out)).toEqual({ continue: true }); // verified schema
  } else {
    expect(out).toBe(""); // exit 0 + empty stdout = allow
  }
}

describe.each(HOOK_HOSTS.map((h) => [h] as const))("host conformance: %s", (host) => {
  const fx = FIXTURES[host];
  const deps = (fetchFn: typeof fetch) => ({
    baseUrl: "http://d",
    host,
    fetchFn,
    now: () => "2026-07-11T12:00:00.000Z",
  });

  it("session-start: canonical cwd -> /search, host-shaped injection", async () => {
    const fetchFn = mockDaemon();
    const out = await handleSessionStart(JSON.stringify(fx.sessionStart), deps(fetchFn));
    const [search] = calls(fetchFn);
    expect(search!.url).toContain("/memwarden/search");
    expect(search!.body).toMatchObject({
      cwd: fx.want.cwd,
      format: "narrative",
      safe_only: true,
      agent: host,
    });
    checkSessionStartResponse(host, out);
  });

  it("prompt: canonical prompt -> observe user_prompt, permissive reply", async () => {
    const fetchFn = mockDaemon();
    const out = await handlePrompt(JSON.stringify(fx.prompt), deps(fetchFn));
    const [observe] = calls(fetchFn);
    expect(observe!.url).toContain("/memwarden/observe");
    expect(observe!.body).toMatchObject({
      hookType: "user_prompt",
      sessionId: fx.want.sessionId,
      project: fx.want.cwd,
      cwd: fx.want.cwd,
      agent: host,
      timestamp: "2026-07-11T12:00:00.000Z",
    });
    expect(observe!.body["data"]).toEqual({ prompt: PROMPT_TEXT });
    checkPromptResponse(host, out);
  });

  it("capture: canonical tool trio -> observe post_tool_use, silent on clean output", async () => {
    const fetchFn = mockDaemon();
    const out = await handleCapture(JSON.stringify(fx.capture), deps(fetchFn));
    const [observe, ...rest] = calls(fetchFn);
    expect(rest).toHaveLength(0); // clean output: no Déjà Fix round-trip
    expect(observe!.url).toContain("/memwarden/observe");
    expect(observe!.body).toMatchObject({
      hookType: "post_tool_use",
      sessionId: fx.want.sessionId,
      cwd: fx.want.cwd,
      agent: host,
    });
    const data = observe!.body["data"] as Record<string, unknown>;
    expect(typeof data["tool_name"]).toBe("string");
    expect(data["tool_name"]).not.toBe("unknown"); // the host's name survived
    expect(data["tool_input"]).toBeTruthy();
    expect(data["tool_output"]).toBe("ok");
    expect(out).toBe("");
  });

  it("session-end: canonical reason -> observe session_end, always silent", async () => {
    const fetchFn = mockDaemon();
    const out = await handleSessionEnd(JSON.stringify(fx.sessionEnd), deps(fetchFn));
    const [observe] = calls(fetchFn);
    expect(observe!.url).toContain("/memwarden/observe");
    expect(observe!.body).toMatchObject({
      hookType: "session_end",
      sessionId: fx.want.sessionId,
      cwd: fx.want.cwd,
      agent: host,
    });
    expect(observe!.body["data"]).toEqual({ reason: fx.want.reason });
    expect(out).toBe("");
  });

  it("malformed stdin never throws and never blocks, for any event", async () => {
    const down = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(handleSessionStart("garbage", deps(down))).resolves.toBe("");
    await expect(handleCapture("garbage", deps(down))).resolves.toBe("");
    await expect(handleSessionEnd("garbage", deps(down))).resolves.toBe("");
    const promptOut = await handlePrompt("garbage", deps(down));
    checkPromptResponse(host, promptOut);
  });
});
