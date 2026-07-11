//
// Lifecycle hook handlers. No network, no live agent: the daemon call is a
// stubbed fetch and stdin is a string. Verifies SessionStart produces a
// valid Claude context-injection (scoped by the event's cwd) and that
// PostToolUse forwards a well-formed observe payload.

import { describe, expect, it, vi } from "vitest";
import {
  handleSessionStart,
  handleCapture,
  handlePrompt,
  handleSessionEnd,
  parseHostEvent,
  formatInjection,
  promptPassthrough,
} from "../src/cli/hook.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("handleSessionStart", () => {
  it("injects narrative context scoped to the event cwd", async () => {
    // Mirror the REAL narrative /search response shape: text lives under
    // `text` (regression for the SessionStart-returns-nothing bug).
    const fetchFn = vi.fn(async () =>
      jsonResponse({ text: "<memory>built the auth module</memory>" }),
    ) as unknown as typeof fetch;

    const out = await handleSessionStart(
      JSON.stringify({ cwd: "/work/alpha", session_id: "s1" }),
      { baseUrl: "http://d", fetchFn },
    );

    const calls = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const body = JSON.parse((calls[0]![1] as { body: string }).body);
    expect(body.cwd).toBe("/work/alpha");
    expect(body.format).toBe("narrative");

    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("auth module");
  });

  it("returns empty (no-op) when there is no memory", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ text: "" })) as unknown as typeof fetch;
    expect(await handleSessionStart("{}", { baseUrl: "http://d", fetchFn })).toBe("");
  });

  it("returns empty when the daemon is down (never throws)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await handleSessionStart("{}", { baseUrl: "http://d", fetchFn })).toBe("");
  });

  it("passes an abort signal and degrades to no-op when the daemon stalls", async () => {
    // A daemon that accepts the connection but never answers must not stall
    // the agent's turn: the hook aborts at its deadline and injects nothing.
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    ) as unknown as typeof fetch;

    const t0 = Date.now();
    const out = await handleSessionStart("{}", {
      baseUrl: "http://d",
      fetchFn,
      timeouts: { inject: 50 },
    });
    expect(out).toBe("");
    expect(Date.now() - t0).toBeLessThan(1500);
    const init = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("handleCapture", () => {
  it("degrades to no-op when the daemon stalls (capture and Déjà Fix both deadline)", async () => {
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    ) as unknown as typeof fetch;

    const out = await handleCapture(
      JSON.stringify({
        session_id: "s9",
        cwd: "/work/stall",
        tool_name: "Bash",
        tool_response: "error: something failed", // triggers the Déjà Fix lookup too
      }),
      { baseUrl: "http://d", fetchFn, timeouts: { capture: 50, dejafix: 50 } },
    );
    expect(out).toBe("");
  });

  it("forwards a well-formed observe payload and injects nothing", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "obs_x" })) as unknown as typeof fetch;
    const out = await handleCapture(
      JSON.stringify({
        session_id: "s2",
        cwd: "/work/beta",
        tool_name: "Edit",
        tool_input: { file: "a.ts" },
        tool_response: "ok",
      }),
      { baseUrl: "http://d", fetchFn, now: () => "2026-01-01T00:00:00.000Z" },
    );
    expect(out).toBe(""); // capture never injects

    const calls = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const url = calls[0]![0] as string;
    const body = JSON.parse((calls[0]![1] as { body: string }).body);
    expect(url).toContain("/memwarden/observe");
    expect(body).toMatchObject({
      hookType: "post_tool_use",
      sessionId: "s2",
      project: "/work/beta",
      cwd: "/work/beta",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(body.data.tool_name).toBe("Edit");
    expect(body.data.tool_output).toBe("ok");
  });

  it("does not throw on malformed stdin or a downed daemon", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(
      handleCapture("not json", { baseUrl: "http://d", fetchFn }),
    ).resolves.toBe("");
  });
});

describe("handleCapture — Déjà Fix injection", () => {
  // Route the mock fetch by URL: observe always ok; lookup returns whatever the
  // test sets. This asserts the REAL response contract (fixes[].status/fix),
  // the lesson from the SessionStart-wrong-key bug.
  function router(lookupBody: unknown, lookupOk = true) {
    return vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/memwarden/dejafix/lookup")) {
        return jsonResponse(lookupBody, lookupOk);
      }
      return jsonResponse({ observationId: "obs_x" });
    }) as unknown as typeof fetch;
  }

  const errorEvent = JSON.stringify({
    session_id: "s3",
    cwd: "/work/gamma",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: "FAIL test/token.test.ts > refresh\nError: clock skew detected",
  });

  it("injects a verified-current fix on a failing tool output", async () => {
    const fetchFn = router({
      signature: "test fail: refresh",
      fixes: [
        {
          fix: "mock NTP in conftest",
          rootCause: "clock skew",
          tool: "codex",
          timestamp: "2026-06-09T10:00:00.000Z",
          status: "verified",
          badge: "verified current",
        },
      ],
    });

    const out = await handleCapture(errorEvent, { baseUrl: "http://d", fetchFn });

    const calls = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // observe first, then the dejafix lookup
    expect(calls.length).toBe(2);
    const lookupUrl = calls[1]![0] as string;
    const lookupBody = JSON.parse((calls[1]![1] as { body: string }).body);
    expect(lookupUrl).toContain("/memwarden/dejafix/lookup");
    expect(lookupBody.cwd).toBe("/work/gamma");
    expect(lookupBody.error_text).toContain("clock skew");

    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Déjà Fix");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("mock NTP in conftest");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("codex");
  });

  it("does NOT auto-inject a sourced-but-unverified fix (conservative)", async () => {
    const fetchFn = router({
      signature: "test fail: refresh",
      fixes: [
        { fix: "maybe restart", timestamp: "2026-06-09T10:00:00.000Z", status: "sourced_unverified", badge: "sourced, unverified" },
      ],
    });
    const out = await handleCapture(errorEvent, { baseUrl: "http://d", fetchFn });
    // lookup still happened (output was an error), but nothing is injected
    const calls = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(2);
    expect(out).toBe("");
  });

  it("does not call lookup at all when the output is not error-shaped", async () => {
    const fetchFn = router({ signature: null, fixes: [] });
    const out = await handleCapture(
      JSON.stringify({ cwd: "/work/gamma", tool_name: "Read", tool_response: "file contents, all good" }),
      { baseUrl: "http://d", fetchFn },
    );
    const calls = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1); // observe only — no second round-trip
    expect(out).toBe("");
  });

  it("never throws if the lookup fails", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/dejafix/")) throw new Error("down");
      return jsonResponse({ observationId: "obs_x" });
    }) as unknown as typeof fetch;
    await expect(
      handleCapture(errorEvent, { baseUrl: "http://d", fetchFn }),
    ).resolves.toBe("");
  });
});

// --- canonical event layer: per-host parsing + output shaping ---------
//
// Fixture events mirror each host's documented stdin shape (July 2026 docs)
// so a host renaming a field breaks a test here, not a user's session.

describe("parseHostEvent", () => {
  it("claude-code / codex / gemini / kiro: session_id + tool_response dialect", () => {
    const raw = JSON.stringify({
      session_id: "s1",
      cwd: "/w/a",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "ok",
    });
    for (const host of ["claude-code", "codex", "gemini", "kiro"] as const) {
      expect(parseHostEvent(raw, host)).toEqual({
        sessionId: "s1",
        cwd: "/w/a",
        toolName: "Bash",
        toolInput: { command: "ls" },
        toolOutput: "ok",
      });
    }
  });

  it("cursor: postToolUse uses tool_output and cwd", () => {
    const raw = JSON.stringify({
      conversation_id: "conv1",
      hook_event_name: "postToolUse",
      workspace_roots: ["/w/root"],
      cwd: "/w/root/sub",
      tool_name: "Shell",
      tool_input: { command: "npm test" },
      tool_output: '"FAIL"',
    });
    expect(parseHostEvent(raw, "cursor")).toEqual({
      sessionId: "conv1",
      cwd: "/w/root/sub",
      toolName: "Shell",
      toolInput: { command: "npm test" },
      toolOutput: '"FAIL"',
    });
  });

  it("cursor: sessionStart falls back to session_id and workspace_roots[0]", () => {
    const raw = JSON.stringify({
      conversation_id: "conv1",
      session_id: "sess1",
      hook_event_name: "sessionStart",
      workspace_roots: ["/w/root"],
    });
    const evt = parseHostEvent(raw, "cursor");
    expect(evt.sessionId).toBe("sess1");
    expect(evt.cwd).toBe("/w/root");
  });

  it("opencode: our plugin sends the canonical field names directly", () => {
    const raw = JSON.stringify({
      sessionId: "oc1",
      cwd: "/w/oc",
      toolName: "bash",
      toolInput: { cmd: "ls" },
      toolOutput: "done",
    });
    expect(parseHostEvent(raw, "opencode")).toEqual({
      sessionId: "oc1",
      cwd: "/w/oc",
      toolName: "bash",
      toolInput: { cmd: "ls" },
      toolOutput: "done",
    });
  });

  it("returns an empty event on malformed JSON for every host", () => {
    for (const host of ["claude-code", "codex", "cursor", "gemini", "kiro", "opencode"] as const) {
      expect(parseHostEvent("not json", host)).toEqual({});
    }
  });
});

describe("formatInjection", () => {
  it("claude-code and codex wrap in hookSpecificOutput with the event name", () => {
    for (const host of ["claude-code", "codex"] as const) {
      const start = JSON.parse(formatInjection(host, "session-start", "ctx"));
      expect(start.hookSpecificOutput).toEqual({
        hookEventName: "SessionStart",
        additionalContext: "ctx",
      });
      const cap = JSON.parse(formatInjection(host, "capture", "fix"));
      expect(cap.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    }
  });

  it("gemini wraps in hookSpecificOutput.additionalContext (no event name)", () => {
    const out = JSON.parse(formatInjection("gemini", "session-start", "ctx"));
    expect(out).toEqual({ hookSpecificOutput: { additionalContext: "ctx" } });
  });

  it("cursor uses top-level additional_context", () => {
    const out = JSON.parse(formatInjection("cursor", "session-start", "ctx"));
    expect(out).toEqual({ additional_context: "ctx" });
  });

  it("kiro and opencode print the raw text (stdout is the context)", () => {
    expect(formatInjection("kiro", "session-start", "ctx")).toBe("ctx");
    expect(formatInjection("opencode", "session-start", "ctx")).toBe("ctx");
  });

  it("empty text is a no-op for every host", () => {
    for (const host of ["claude-code", "codex", "cursor", "gemini", "kiro", "opencode"] as const) {
      expect(formatInjection(host, "session-start", "")).toBe("");
    }
  });
});

describe("host-aware handlers", () => {
  it("cursor session start replies with additional_context and heartbeats its host", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ text: "<memory>cursor knows</memory>" }),
    ) as unknown as typeof fetch;
    const out = await handleSessionStart(
      JSON.stringify({ conversation_id: "c1", workspace_roots: ["/w/cur"] }),
      { baseUrl: "http://d", fetchFn, host: "cursor" },
    );
    const calls = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const body = JSON.parse((calls[0]![1] as { body: string }).body);
    expect(body.cwd).toBe("/w/cur");
    expect(body.agent).toBe("cursor"); // liveness heartbeat rides the search call
    const parsed = JSON.parse(out);
    expect(parsed.additional_context).toContain("cursor knows");
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it("gemini capture forwards tool_response and stamps agent on observe", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "obs_1" })) as unknown as typeof fetch;
    const out = await handleCapture(
      JSON.stringify({
        session_id: "g1",
        cwd: "/w/gem",
        tool_name: "run_shell_command",
        tool_input: { command: "ls" },
        tool_response: "ok",
      }),
      { baseUrl: "http://d", fetchFn, host: "gemini", now: () => "2026-01-01T00:00:00.000Z" },
    );
    expect(out).toBe("");
    const calls = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const body = JSON.parse((calls[0]![1] as { body: string }).body);
    expect(body).toMatchObject({
      sessionId: "g1",
      project: "/w/gem",
      agent: "gemini",
    });
    expect(body.data.tool_name).toBe("run_shell_command");
    expect(body.data.tool_output).toBe("ok");
  });

  it("kiro Déjà Fix injection is plain text (stdout is the context)", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/dejafix/lookup")) {
        return jsonResponse({
          signature: "sig",
          fixes: [{ fix: "pin the dep", status: "verified", timestamp: "2026-06-01T00:00:00.000Z" }],
        });
      }
      return jsonResponse({ observationId: "obs_1" });
    }) as unknown as typeof fetch;
    const out = await handleCapture(
      JSON.stringify({
        session_id: "k1",
        cwd: "/w/kiro",
        tool_name: "execute_bash",
        tool_input: { command: "npm test" },
        tool_response: "Error: dep mismatch",
      }),
      { baseUrl: "http://d", fetchFn, host: "kiro" },
    );
    expect(out).toContain("Déjà Fix");
    expect(out).toContain("pin the dep");
    expect(() => JSON.parse(out)).toThrow(); // plain text, not JSON
  });

  it("defaults to the claude-code dialect when host is omitted (back-compat)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ text: "remembered" }),
    ) as unknown as typeof fetch;
    const out = await handleSessionStart(
      JSON.stringify({ session_id: "s", cwd: "/w" }),
      { baseUrl: "http://d", fetchFn },
    );
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });
});

// --- handlePrompt: per-host prompt-event fixtures ------------------------
//
// Fixtures mirror each host's documented stdin for its prompt event
// (July 2026): Claude Code UserPromptSubmit, Cursor beforeSubmitPrompt, and
// Gemini BeforeAgent are verified; Codex UserPromptSubmit and Kiro
// userPromptSubmit assume the Claude-style `prompt` key.

function observeCall(fetchFn: unknown): { url: string; body: Record<string, unknown> } {
  const calls = (fetchFn as { mock: { calls: unknown[][] } }).mock.calls;
  return {
    url: calls[0]![0] as string,
    body: JSON.parse((calls[0]![1] as { body: string }).body),
  };
}

describe("handlePrompt", () => {
  it("claude-code UserPromptSubmit: captures the prompt, prints nothing", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    const out = await handlePrompt(
      JSON.stringify({
        session_id: "s1",
        transcript_path: "/t.jsonl",
        cwd: "/w/a",
        permission_mode: "default",
        hook_event_name: "UserPromptSubmit",
        prompt: "Write a test for the login function",
      }),
      { baseUrl: "http://d", fetchFn, now: () => "2026-07-11T00:00:00.000Z" },
    );
    expect(out).toBe(""); // exit 0, no JSON = allow
    const { url, body } = observeCall(fetchFn);
    expect(url).toContain("/memwarden/observe");
    expect(body).toMatchObject({
      hookType: "user_prompt",
      sessionId: "s1",
      project: "/w/a",
      cwd: "/w/a",
      agent: "claude-code",
      timestamp: "2026-07-11T00:00:00.000Z",
    });
    expect(body.data).toEqual({ prompt: "Write a test for the login function" });
  });

  it("cursor beforeSubmitPrompt: captures and returns {continue:true}", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    const out = await handlePrompt(
      JSON.stringify({
        conversation_id: "conv1",
        workspace_roots: ["/w/cur"],
        hook_event_name: "beforeSubmitPrompt",
        prompt: "refactor the parser",
        attachments: [],
      }),
      { baseUrl: "http://d", fetchFn, host: "cursor" },
    );
    expect(JSON.parse(out)).toEqual({ continue: true });
    const { body } = observeCall(fetchFn);
    expect(body).toMatchObject({
      hookType: "user_prompt",
      sessionId: "conv1",
      cwd: "/w/cur",
      agent: "cursor",
    });
    expect((body.data as { prompt: string }).prompt).toBe("refactor the parser");
  });

  it("cursor NEVER blocks: {continue:true} even when the daemon is down", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const out = await handlePrompt(
      JSON.stringify({ conversation_id: "c", workspace_roots: ["/w"], prompt: "hi" }),
      { baseUrl: "http://d", fetchFn, host: "cursor" },
    );
    expect(JSON.parse(out)).toEqual({ continue: true });
  });

  it("cursor NEVER blocks: {continue:true} even on malformed stdin", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const out = await handlePrompt("not json", { baseUrl: "http://d", fetchFn, host: "cursor" });
    expect(JSON.parse(out)).toEqual({ continue: true });
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("gemini BeforeAgent: captures the prompt with the gemini heartbeat", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    const out = await handlePrompt(
      JSON.stringify({
        session_id: "g1",
        cwd: "/w/gem",
        hook_event_name: "BeforeAgent",
        prompt: "add a changelog",
      }),
      { baseUrl: "http://d", fetchFn, host: "gemini" },
    );
    expect(out).toBe("");
    const { body } = observeCall(fetchFn);
    expect(body).toMatchObject({ hookType: "user_prompt", sessionId: "g1", agent: "gemini" });
  });

  it("codex and kiro (assumed Claude-style prompt key) capture and stay silent", async () => {
    for (const host of ["codex", "kiro"] as const) {
      const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
      const out = await handlePrompt(
        JSON.stringify({ session_id: "x1", cwd: "/w/x", prompt: "do the thing" }),
        { baseUrl: "http://d", fetchFn, host },
      );
      expect(out).toBe("");
      const { body } = observeCall(fetchFn);
      expect(body).toMatchObject({ hookType: "user_prompt", agent: host });
    }
  });

  it("opencode plugin event (canonical fields) captures", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    const out = await handlePrompt(
      JSON.stringify({ sessionId: "oc1", cwd: "/w/oc", prompt: "wire the plugin" }),
      { baseUrl: "http://d", fetchFn, host: "opencode" },
    );
    expect(out).toBe("");
    const { body } = observeCall(fetchFn);
    expect(body).toMatchObject({ hookType: "user_prompt", sessionId: "oc1", agent: "opencode" });
  });

  it("an empty prompt never reaches the daemon", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const out = await handlePrompt(
      JSON.stringify({ session_id: "s", cwd: "/w", prompt: "   " }),
      { baseUrl: "http://d", fetchFn },
    );
    expect(out).toBe("");
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("caps a giant prompt in the POST body", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    await handlePrompt(
      JSON.stringify({ session_id: "s", cwd: "/w", prompt: "y".repeat(20_000) }),
      { baseUrl: "http://d", fetchFn },
    );
    const { body } = observeCall(fetchFn);
    expect((body.data as { prompt: string }).prompt.length).toBeLessThanOrEqual(4000);
  });

  it("degrades to permissive when the daemon stalls (abort at deadline)", async () => {
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    ) as unknown as typeof fetch;
    const out = await handlePrompt(
      JSON.stringify({ conversation_id: "c", workspace_roots: ["/w"], prompt: "hi" }),
      { baseUrl: "http://d", fetchFn, host: "cursor", timeouts: { prompt: 50 } },
    );
    expect(JSON.parse(out)).toEqual({ continue: true });
  });
});

describe("promptPassthrough", () => {
  it("cursor gets {continue:true}; every other host gets empty stdout", () => {
    expect(JSON.parse(promptPassthrough("cursor"))).toEqual({ continue: true });
    for (const host of ["claude-code", "codex", "gemini", "kiro", "opencode"] as const) {
      expect(promptPassthrough(host)).toBe("");
    }
  });
});

// --- handleSessionEnd: per-host end-of-session fixtures ------------------

describe("handleSessionEnd", () => {
  it("claude-code SessionEnd: posts session_end with the reason", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    const out = await handleSessionEnd(
      JSON.stringify({
        session_id: "s1",
        cwd: "/w/a",
        hook_event_name: "SessionEnd",
        reason: "prompt_input_exit",
      }),
      { baseUrl: "http://d", fetchFn, now: () => "2026-07-11T01:00:00.000Z" },
    );
    expect(out).toBe("");
    const { url, body } = observeCall(fetchFn);
    expect(url).toContain("/memwarden/observe");
    expect(body).toMatchObject({
      hookType: "session_end",
      sessionId: "s1",
      cwd: "/w/a",
      agent: "claude-code",
      timestamp: "2026-07-11T01:00:00.000Z",
    });
    expect(body.data).toEqual({ reason: "prompt_input_exit" });
  });

  it("cursor sessionEnd: session_id + workspace_roots (no cwd on this event)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    await handleSessionEnd(
      JSON.stringify({
        session_id: "sess1",
        reason: "completed",
        duration_ms: 120000,
        workspace_roots: ["/w/cur"],
      }),
      { baseUrl: "http://d", fetchFn, host: "cursor" },
    );
    const { body } = observeCall(fetchFn);
    expect(body).toMatchObject({
      hookType: "session_end",
      sessionId: "sess1",
      cwd: "/w/cur",
      agent: "cursor",
    });
    expect(body.data).toEqual({ reason: "completed" });
  });

  it("codex Stop and kiro stop (no reason field) default to 'unknown'", async () => {
    for (const host of ["codex", "kiro"] as const) {
      const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
      const out = await handleSessionEnd(
        JSON.stringify({ session_id: "x1", cwd: "/w/x" }),
        { baseUrl: "http://d", fetchFn, host },
      );
      expect(out).toBe("");
      const { body } = observeCall(fetchFn);
      expect(body).toMatchObject({ hookType: "session_end", agent: host });
      expect(body.data).toEqual({ reason: "unknown" });
    }
  });

  it("codex Stop forwards last_assistant_message as the session OUTCOME (verified field, learn.chatgpt.com/docs/hooks)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    await handleSessionEnd(
      JSON.stringify({
        session_id: "x1",
        cwd: "/w/x",
        hook_event_name: "Stop",
        turn_id: "t9",
        stop_hook_active: false,
        last_assistant_message: "Done — rotated the deploy keys and updated the docs.",
      }),
      { baseUrl: "http://d", fetchFn, host: "codex" },
    );
    const { body } = observeCall(fetchFn);
    expect(body).toMatchObject({ hookType: "session_end", agent: "codex" });
    expect(body.data).toEqual({
      reason: "unknown",
      assistant_response: "Done — rotated the deploy keys and updated the docs.",
    });
  });

  it("kiro stop forwards assistant_response as the session OUTCOME (verified field, kiro.dev/docs/cli/hooks)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    await handleSessionEnd(
      JSON.stringify({
        session_id: "k1",
        cwd: "/w/k",
        hook_event_name: "stop",
        assistant_response: "All tests green; the limiter now uses a token bucket.",
      }),
      { baseUrl: "http://d", fetchFn, host: "kiro" },
    );
    const { body } = observeCall(fetchFn);
    expect(body).toMatchObject({ hookType: "session_end", agent: "kiro" });
    expect(body.data).toEqual({
      reason: "unknown",
      assistant_response: "All tests green; the limiter now uses a token bucket.",
    });
  });

  it("caps a huge assistant message before POSTing (stop hooks stay cheap)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    await handleSessionEnd(
      JSON.stringify({ session_id: "x1", cwd: "/w/x", last_assistant_message: "z".repeat(20_000) }),
      { baseUrl: "http://d", fetchFn, host: "codex" },
    );
    const { body } = observeCall(fetchFn);
    expect(((body.data as { assistant_response: string }).assistant_response).length).toBeLessThanOrEqual(4000);
  });

  it("gemini SessionEnd carries its documented reason values", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    await handleSessionEnd(
      JSON.stringify({ session_id: "g1", cwd: "/w/gem", hook_event_name: "SessionEnd", reason: "exit" }),
      { baseUrl: "http://d", fetchFn, host: "gemini" },
    );
    const { body } = observeCall(fetchFn);
    expect(body.data).toEqual({ reason: "exit" });
  });

  it("opencode session.idle (canonical fields from our plugin)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ observationId: "o" })) as unknown as typeof fetch;
    await handleSessionEnd(
      JSON.stringify({ sessionId: "oc1", cwd: "/w/oc", reason: "idle" }),
      { baseUrl: "http://d", fetchFn, host: "opencode" },
    );
    const { body } = observeCall(fetchFn);
    expect(body).toMatchObject({ hookType: "session_end", sessionId: "oc1", agent: "opencode" });
    expect(body.data).toEqual({ reason: "idle" });
  });

  it("never throws on malformed stdin or a downed daemon", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(handleSessionEnd("not json", { baseUrl: "http://d", fetchFn })).resolves.toBe("");
  });

  it("degrades to no-op when the daemon stalls (abort at deadline)", async () => {
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    ) as unknown as typeof fetch;
    const t0 = Date.now();
    const out = await handleSessionEnd(
      JSON.stringify({ session_id: "s", cwd: "/w" }),
      { baseUrl: "http://d", fetchFn, timeouts: { sessionEnd: 50 } },
    );
    expect(out).toBe("");
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
