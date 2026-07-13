//
// Unit tests for the observe session-project-mismatch guard: a session's
// project identity is fixed at creation; reused sessionIds under a different
// project must be refused (defense-in-depth on top of per-project MCP/proxy ids).

import { describe, expect, it } from "vitest";
import { sessionProjectMismatch } from "../src/functions/observe.js";

describe("sessionProjectMismatch", () => {
  it("detects different projectKeys", () => {
    expect(
      sessionProjectMismatch(
        { projectKey: "git:https://example.com/a.git" },
        { projectKey: "git:https://example.com/b.git" },
      ),
    ).toBe(true);
  });

  it("allows matching projectKeys (worktree / moved-checkout widening)", () => {
    expect(
      sessionProjectMismatch(
        {
          project: "/work/a",
          cwd: "/work/a",
          projectKey: "git:https://example.com/a.git",
        },
        {
          project: "/work/a-wt",
          cwd: "/work/a-wt",
          projectKey: "git:https://example.com/a.git",
        },
      ),
    ).toBe(false);
  });

  it("falls back to canonical project path when keys are absent", () => {
    expect(
      sessionProjectMismatch(
        { project: "/work/proj-X", cwd: "/work/proj-X" },
        { project: "/work/proj-Y", cwd: "/work/proj-Y" },
      ),
    ).toBe(true);
    expect(
      sessionProjectMismatch(
        { project: "/work/proj-X", cwd: "/work/proj-X" },
        { project: "/work/proj-X", cwd: "/work/proj-X" },
      ),
    ).toBe(false);
  });

  it("fails open when either side lacks comparable identity", () => {
    expect(sessionProjectMismatch({}, { project: "/work/x" })).toBe(false);
    expect(sessionProjectMismatch({ project: "/work/x" }, {})).toBe(false);
  });
});
