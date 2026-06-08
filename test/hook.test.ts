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
    const fetchFn = vi.fn(async () =>
      jsonResponse({ context: "<memory>built the auth module</memory>" }),
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
    const fetchFn = vi.fn(async () => jsonResponse({ context: "" })) as unknown as typeof fetch;
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
