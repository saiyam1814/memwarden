//
// Lifecycle hook handlers. No network, no live agent: the daemon call is a
// stubbed fetch and stdin is a string. Verifies SessionStart produces a
// valid Claude context-injection (scoped by the event's cwd) and that
// PostToolUse forwards a well-formed observe payload.

import { describe, expect, it, vi } from "vitest";
import { handleSessionStart, handleCapture } from "../src/cli/hook.js";

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
});

describe("handleCapture", () => {
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
