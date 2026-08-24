//
// Extraction quality — the gate that should have existed from day one.
//
// A real six-week install produced 379 "memories" that looked like this:
//
//   title: "Write"
//   body : {"file_path":"/Users/…/email-to-preet.txt","content":"Subject: Re: …
//   facts: []   concepts: []
//
// Every title was one of six tool names, every body was raw tool-input JSON,
// and facts/concepts were always empty — so nothing was rankable, readable, or
// lexically searchable. Provenance and hashing worked perfectly and were
// verifying junk. That is the "world's best vault around an empty vault"
// failure, and no amount of firewall quality compensates for it.
//
// These tests pin the shape of a memory worth recalling. The two negative
// assertions at the bottom are the actual regression gate: a title that is bare
// a tool name, and a body that parses as tool-input JSON, are both defects.

import { describe, expect, it } from "vitest";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";
import type { RawObservation } from "../src/functions/types.js";

function raw(over: Partial<RawObservation>): RawObservation {
  return {
    id: "obs-1",
    sessionId: "s1",
    timestamp: "2026-08-24T10:00:00.000Z",
    hookType: "post_tool_use",
    raw: {},
    ...over,
  } as RawObservation;
}

const TOOL_NAMES = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task"];

describe("extraction: titles describe the change, not the tool", () => {
  it("an edit with a short replacement puts the change IN the title", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Edit",
        toolInput: {
          file_path: "/repo/src/auth.ts",
          old_string: "ROTATE_MS = 900_000",
          new_string: "ROTATE_MS = 3_600_000",
        },
        toolOutput: "ok",
      }),
    );
    expect(c.title).toBe("auth.ts: ROTATE_MS = 900_000 → ROTATE_MS = 3_600_000");
    // The change is also a first-class fact, so it survives distillation.
    expect(c.facts.some((f) => f.includes("900_000") && f.includes("3_600_000"))).toBe(true);
  });

  it("a long replacement degrades to a readable summary, not a tool name", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Edit",
        toolInput: {
          file_path: "/repo/src/auth.ts",
          old_string: "x".repeat(120),
          new_string: "y".repeat(120),
        },
      }),
    );
    expect(c.title).toBe("Edited auth.ts");
  });

  it("a command becomes its own title", () => {
    const c = buildSyntheticCompression(
      raw({ toolName: "Bash", toolInput: { command: "npm test -- --coverage" }, toolOutput: "ok" }),
    );
    expect(c.title).toBe("npm test -- --coverage");
  });

  it("a heredoc command is summarized to its first clause", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Bash",
        toolInput: { command: "cat >> notes.md <<'EOF'\nlots of body text\nEOF" },
      }),
    );
    expect(c.title).toBe("cat >> notes.md");
    expect(c.title.length).toBeLessThan(40);
  });

  it("a search records what was searched for", () => {
    const c = buildSyntheticCompression(
      raw({ toolName: "Grep", toolInput: { pattern: "authentication" } }),
    );
    expect(c.title).toBe('Searched "authentication"');
  });

  it("a plain read still names the file", () => {
    const c = buildSyntheticCompression(
      raw({ toolName: "Read", toolInput: { file_path: "/repo/docs/architecture.md" } }),
    );
    expect(c.title).toBe("Read architecture.md");
  });
});

describe("extraction: bodies are prose, never tool-input JSON", () => {
  it("does not store the raw tool input as the narrative", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Write",
        toolInput: { file_path: "/repo/mail.txt", content: "Subject: hello there" },
      }),
    );
    expect(c.narrative).not.toContain('{"file_path"');
    expect(c.narrative).not.toMatch(/^\s*\{/);
    expect(c.narrative).toContain("mail.txt");
  });

  it("keeps tool output as evidence but bounded", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Bash",
        toolInput: { command: "npm test" },
        toolOutput: "z".repeat(5000),
      }),
    );
    expect(c.narrative.length).toBeLessThanOrEqual(600);
  });
});

describe("extraction: facts and concepts are populated", () => {
  it("extracts an error line as a fact — the fuel Déjà Fix runs on", () => {
    const c = buildSyntheticCompression(
      raw({
        hookType: "post_tool_failure",
        toolName: "Bash",
        toolInput: { command: "npm run build" },
        toolOutput: "TS2304: Cannot find name 'foo'",
      }),
    );
    expect(c.facts.some((f) => f.startsWith("error:"))).toBe(true);
    // Failures are the highest-value capture, so they outrank the sweep floor.
    expect(c.importance).toBeGreaterThan(5);
  });

  it("derives searchable concepts from paths and symbols", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Edit",
        toolInput: {
          file_path: "/repo/src/triggers/api.ts",
          old_string: "const MAX_RETRIES = 3",
          new_string: "const MAX_RETRIES = 5",
        },
      }),
    );
    expect(c.concepts).toContain("api");
    expect(c.concepts).toContain("triggers");
    expect(c.concepts).toContain("MAX_RETRIES");
  });

  it("caps concepts so one huge diff cannot flood the index", () => {
    const many = Array.from({ length: 60 }, (_, i) => `SYMBOL_${i}`).join(" ");
    const c = buildSyntheticCompression(
      raw({
        toolName: "Edit",
        toolInput: { file_path: "/repo/a.ts", old_string: many, new_string: many },
      }),
    );
    expect(c.concepts.length).toBeLessThanOrEqual(16);
  });
});

describe("extraction: worthless captures are marked for aging out", () => {
  it("a bare read with no signal falls below the retention floor", () => {
    // This is what filled the store: reads with nothing extractable, promoted
    // into permanent memories. Below importance 5 the retention sweep can
    // remove them instead of distilling them forever.
    const c = buildSyntheticCompression(
      raw({ toolName: "Read", toolInput: { file_path: "/repo/x.bin" } }),
    );
    expect(c.importance).toBeLessThan(5);
  });

  it("a read that produced real signal is NOT downgraded", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Read",
        toolInput: { file_path: "/repo/src/auth.ts" },
        toolOutput: "export const ROTATE_MS = 900_000;",
      }),
    );
    expect(c.concepts.length).toBeGreaterThan(0);
    expect(c.importance).toBeGreaterThanOrEqual(4);
  });
});

// Three bugs the FIRST version of this rewrite shipped, caught by inspecting
// real captures on a live machine rather than fixtures. Each is pinned here.
describe("extraction: bugs found on a live install", () => {
  it("does not treat a declared-success payload as an error", () => {
    // Observed: every capture came back importance 6 because the output merely
    // contained the word "error" somewhere, or was a {"success":true} envelope.
    // Marking everything top-priority destroys ranking entirely.
    const c = buildSyntheticCompression(
      raw({
        toolName: "Grep",
        toolInput: { pattern: "todo" },
        toolOutput: '{"success":true,"output":"Found 30 files, none with errors"}',
      }),
    );
    expect(c.facts.some((f) => f.startsWith("error:"))).toBe(false);
    expect(c.importance).toBeLessThanOrEqual(5);
  });

  it("does not treat a file that merely mentions errors as a failure", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Read",
        toolInput: { file_path: "/repo/src/handler.ts" },
        toolOutput: "// handles the error case by retrying\nexport function handler() {}",
      }),
    );
    expect(c.facts.some((f) => f.startsWith("error:"))).toBe(false);
  });

  it("never puts a JSON payload into a fact", () => {
    const c = buildSyntheticCompression(
      raw({
        hookType: "post_tool_failure",
        toolName: "Bash",
        toolInput: { command: "deploy" },
        toolOutput: '{"success":false,"output":"deep JSON blob here"}',
      }),
    );
    for (const f of c.facts) {
      expect(f).not.toMatch(/\{\s*"/);
    }
  });

  it("does not leak the OS username into concepts", () => {
    // Personal data, identical on every memory on the machine, zero retrieval
    // value. Observed: "saiyam" appeared in every concept list.
    const c = buildSyntheticCompression(
      raw({
        toolName: "Read",
        toolInput: { file_path: "/Users/saiyam/git/kubmin/frontend/src/app/billing/page.tsx" },
      }),
    );
    expect(c.concepts).not.toContain("saiyam");
    // ...while still keeping the parts that identify the work.
    expect(c.concepts).toContain("kubmin");
    expect(c.concepts).toContain("billing");
  });

  it("does not fuse escape sequences into identifiers", () => {
    // Observed: JSON-encoded output containing "\\tisPremium" was mined as the
    // symbol "tisPremium", and "\\nTHE" as "nTHE".
    const c = buildSyntheticCompression(
      raw({
        toolName: "Read",
        toolInput: { file_path: "/repo/svc/pricing.go" },
        toolOutput: '{"success":true,"output":"426|\\t}, nil\\n\\tisPremium := true"}',
      }),
    );
    expect(c.concepts).toContain("isPremium");
    expect(c.concepts).not.toContain("tisPremium");
  });

  it("does not mine shouty English as CONSTANT_CASE identifiers", () => {
    // Observed: "THE", "REGRESSION", "GATE", "PASS" from logs and comments were
    // burying the real identifiers. CONSTANT_CASE now needs an underscore or digit.
    const c = buildSyntheticCompression(
      raw({
        toolName: "Read",
        toolInput: { file_path: "/repo/svc/limits.go" },
        toolOutput: "THE REGRESSION GATE PASS — const MAX_RETRIES = 3; const HTTP2_ONLY = true",
      }),
    );
    expect(c.concepts).toContain("MAX_RETRIES");
    expect(c.concepts).toContain("HTTP2_ONLY");
    for (const noise of ["THE", "REGRESSION", "GATE", "PASS"]) {
      expect(c.concepts).not.toContain(noise);
    }
  });

  it("does not mine a glob or regex pattern as if it were a path", () => {
    const c = buildSyntheticCompression(
      raw({ toolName: "Glob", toolInput: { pattern: "**/page.tsx" } }),
    );
    for (const concept of c.concepts) {
      expect(concept).not.toContain("*");
      expect(concept).not.toContain("|");
    }
  });
});

// THE REGRESSION GATE. Cheap, and it would have caught the original defect on
// day one instead of six weeks in.
describe("extraction: the regression gate", () => {
  const cases: RawObservation[] = [
    raw({ toolName: "Read", toolInput: { file_path: "/repo/src/a.ts" } }),
    raw({ toolName: "Write", toolInput: { file_path: "/repo/b.ts", content: "x" } }),
    raw({
      toolName: "Edit",
      toolInput: { file_path: "/repo/c.ts", old_string: "a", new_string: "b" },
    }),
    raw({ toolName: "Bash", toolInput: { command: "ls -la" } }),
    raw({ toolName: "Grep", toolInput: { pattern: "todo" } }),
  ];

  it("no memory title is ever a bare tool name", () => {
    for (const r of cases) {
      const c = buildSyntheticCompression(r);
      expect(TOOL_NAMES).not.toContain(c.title);
    }
  });

  it("no memory body parses as JSON carrying a file_path", () => {
    for (const r of cases) {
      const c = buildSyntheticCompression(r);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(c.narrative);
      } catch {
        parsed = null;
      }
      const looksLikeToolInput =
        !!parsed && typeof parsed === "object" && "file_path" in (parsed as object);
      expect(looksLikeToolInput).toBe(false);
    }
  });
});
