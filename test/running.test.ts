//
// Running-tool discovery: the pure matcher over process basenames. The ps
// wrapper itself is a thin shell-out; what matters is that tool ids map to
// the right process names and that "unknown" is never conflated with "not
// running" (win32 has no cheap process table here).

import { describe, expect, it } from "vitest";
import {
  matchesTool,
  toolRunState,
  restartAdvice,
} from "../src/cli/running.js";

const procs = (...names: string[]) => new Set(names.map((n) => n.toLowerCase()));

describe("running-tool discovery", () => {
  it("matches CLI agents and GUI apps by process basename", () => {
    expect(matchesTool("claude-code", procs("claude"))).toBe(true);
    expect(matchesTool("codex", procs("codex"))).toBe(true);
    expect(matchesTool("cursor", procs("Cursor Helper (Renderer)"))).toBe(true);
    expect(matchesTool("opencode", procs("node", "opencode"))).toBe(true);
    expect(matchesTool("codex", procs("node", "zsh", "Cursor"))).toBe(false);
    expect(matchesTool("nonexistent-tool", procs("claude"))).toBe(false);
  });

  it("null process table means unknown, never not-running", () => {
    expect(toolRunState("cursor", null)).toBe("unknown");
    expect(toolRunState("cursor", procs("cursor"))).toBe("running");
    expect(toolRunState("cursor", procs("zsh"))).toBe("not running");
  });

  it("advice distinguishes GUI restart from CLI next-session pickup", () => {
    expect(restartAdvice("cursor", "running")).toContain("restart");
    expect(restartAdvice("codex", "running")).toContain("NEXT session");
    expect(restartAdvice("codex", "not running")).toContain("nothing to do");
    expect(restartAdvice("codex", "unknown")).toContain("could not check");
  });
});
