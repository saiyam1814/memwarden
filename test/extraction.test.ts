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

  it("never embeds a JSON output envelope in the body", () => {
    // Observed after the first pass: "Wrote inspect-store.ts. {"type":"create",
    // "filePath":"…","content":"//\\n…"" — an entire written file stored inside
    // its own memory. The JSON guard covered facts but not the output append.
    const c = buildSyntheticCompression(
      raw({
        toolName: "Write",
        toolInput: { file_path: "/repo/eval/inspect.ts", content: "x" },
        toolOutput:
          '{"type":"create","filePath":"/repo/eval/inspect.ts","content":"// a very long file body that must not be stored"}',
      }),
    );
    expect(c.narrative).not.toContain('"content"');
    expect(c.narrative).not.toContain("must not be stored");
    expect(c.narrative).not.toMatch(/\{\s*"/);
  });

  it("mines a readable line out of a stdout envelope instead of the envelope", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Bash",
        toolInput: { command: "npm test" },
        toolOutput: '{"stdout":"Tests 761 passed (761)","exitCode":0}',
      }),
    );
    expect(c.narrative).toContain("761 passed");
    expect(c.narrative).not.toContain('"exitCode"');
    expect(c.narrative).not.toMatch(/\{\s*"/);
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

// --- gaps found by inspecting a month of live 0.1.1 captures ----------------
//
// Real September captures, 7,000+ of them titled with a bare tool name:
// WebFetch (1,250), web_search (910), webfetch (633), WebSearch (546),
// todo/MCP/subagent tools, 300 `<task-notification>` prompts, and hundreds of
// commands titled by a `SP=/private/tmp/…` variable assignment. Envelope KEYS
// (`isImage`, `noOutputExpected`, `codeText`, `durationSeconds`) were mined
// as concepts on thousands of unrelated memories.

import { extractProvenance } from "../src/functions/provenance.js";
import { classifyProvenance } from "../src/functions/verify.js";

describe("extraction: web, MCP, and subagent tools say what they did", () => {
  it("WebFetch is titled by what was fetched, with the host as a concept", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "WebFetch",
        toolInput: { url: "https://learn.chatgpt.com/docs/changelog?x=1", prompt: "find memory entries" },
        toolOutput: { bytes: 1542032, code: 200, codeText: "OK", result: "# Changelog\nSeptember 25: /import added" },
      }),
    );
    expect(c.title).toBe("Fetched learn.chatgpt.com/docs/changelog");
    expect(c.concepts).toContain("learn.chatgpt.com");
    expect(c.concepts).not.toContain("codeText");
    expect(c.narrative).toContain("September 25");
  });

  it("WebSearch (and lowercase host variants) name the query and the result titles", () => {
    for (const toolName of ["WebSearch", "web_search"]) {
      const c = buildSyntheticCompression(
        raw({
          toolName,
          toolInput: { query: "OWASP ASI06 memory poisoning" },
          toolOutput: {
            query: "OWASP ASI06 memory poisoning",
            results: [
              { tool_use_id: "srvtoolu_1", content: [
                { title: "OWASP Top 10 for Agentic Applications", url: "https://genai.owasp.org/" },
                { title: "Memory & Context Poisoning", url: "https://example.org/asi06" },
              ] },
            ],
            durationSeconds: 3.2,
          },
        }),
      );
      expect(c.title).toBe('Searched web: "OWASP ASI06 memory poisoning"');
      expect(c.narrative).toContain("results: OWASP Top 10 for Agentic Applications; Memory & Context Poisoning");
      expect(c.concepts).not.toContain("durationSeconds");
    }
    const lower = buildSyntheticCompression(
      raw({ toolName: "webfetch", toolInput: { url: "https://arxiv.org/abs/2608.21230" } }),
    );
    expect(lower.title).toBe("Fetched arxiv.org/abs/2608.21230");
  });

  it("MCP and subagent tools are titled by their intent field", () => {
    const slack = buildSyntheticCompression(
      raw({
        toolName: "mcp__claude_ai_Slack__slack_search_public_and_private",
        toolInput: { query: "release notes 0.1.1" },
      }),
    );
    expect(slack.title).toBe('slack_search_public_and_private: "release notes 0.1.1"');
    const agent = buildSyntheticCompression(
      raw({ toolName: "Agent", toolInput: { description: "Research agent-memory space", prompt: "long…" } }),
    );
    expect(agent.title).toBe("Agent: Research agent-memory space");
    const nav = buildSyntheticCompression(
      raw({ toolName: "mcp__claude-in-chrome__navigate", toolInput: { url: "https://github.com/saiyam1814/memwarden" } }),
    );
    expect(nav.title).toBe("navigate: github.com/saiyam1814/memwarden");
    const click = buildSyntheticCompression(
      raw({ toolName: "mcp__claude-in-chrome__computer", toolInput: { action: "screenshot", tabId: 3 } }),
    );
    expect(click.title).toBe("computer: screenshot");
  });

  it("a background task notification is titled by its summary and ranked below real prompts", () => {
    const c = buildSyntheticCompression(
      raw({
        hookType: "user_prompt",
        userPrompt:
          "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"Run tests\" completed (exit code 0)</summary>\n</task-notification>",
      }),
    );
    expect(c.title).toBe('Background command "Run tests" completed (exit code 0)');
    expect(c.importance).toBeLessThan(6);
    const real = buildSyntheticCompression(raw({ hookType: "user_prompt", userPrompt: "fix the login bug" }));
    expect(real.importance).toBe(6);
  });
});

describe("extraction: command titles skip setup clauses", () => {
  it.each([
    ['SP=/private/tmp/claude-501/x/scratchpad && cat "$SP/out.txt"', 'cat "$SP/out.txt"'],
    ["cd /repo && npm test -- --run", "npm test -- --run"],
    ["FOO=1 BAR=2 npm run build", "npm run build"],
    ["export NODE_ENV=test; vitest run", "vitest run"],
    ["git status --short", "git status --short"],
  ])("%s -> %s", (command, title) => {
    const c = buildSyntheticCompression(raw({ toolName: "Bash", toolInput: { command } }));
    expect(c.title).toBe(title);
  });

  it("the body does not repeat the command as a `ran:` fact", () => {
    const c = buildSyntheticCompression(
      raw({ toolName: "Bash", toolInput: { command: "wc -l src/a.ts" }, toolOutput: { stdout: "42 src/a.ts" } }),
    );
    expect(c.facts).toContain("ran: wc -l src/a.ts");
    expect(c.narrative).toBe("wc -l src/a.ts. 42 src/a.ts");
  });

  it("does not mine tool-envelope keys as concepts", () => {
    const c = buildSyntheticCompression(
      raw({
        toolName: "Bash",
        toolInput: { command: "grep -rn readOplog src" },
        toolOutput: {
          stdout: "src/state/store.ts:180: readOplog(sinceId?: number): Promise<OplogEntry[]>;",
          stderr: "",
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      }),
    );
    expect(c.concepts).toContain("readOplog");
    expect(c.concepts).toContain("OplogEntry");
    expect(c.concepts).not.toContain("isImage");
    expect(c.concepts).not.toContain("noOutputExpected");
  });
});

describe("globs are never file evidence", () => {
  it("a Glob pattern is not recorded as a file, in the memory or its provenance", () => {
    const c = buildSyntheticCompression(raw({ toolName: "Glob", toolInput: { pattern: "**/*.test.ts" } }));
    expect(c.title).toBe('Searched "**/*.test.ts"');
    expect(c.files).toEqual([]);
    const prov = extractProvenance({
      cwd: "/repo",
      data: { tool_name: "Glob", tool_input: { pattern: "**/*.test.ts", path: "/repo/src" } },
    });
    expect(prov.files).toEqual(["src"]);
  });

  it("a Grep `glob` filter is not a file either", () => {
    const prov = extractProvenance({
      cwd: "/repo",
      data: {
        tool_name: "Grep",
        tool_input: { pattern: "", glob: "**/.github/workflows/*.{yml,yaml}", output_mode: "files_with_matches" },
      },
    });
    expect(prov.files ?? []).toEqual([]);
  });

  it("legacy memories carrying a glob as a file are not refused as stale", () => {
    const v = classifyProvenance(
      { files: ["**/*.ts"], command: "Glob", cwd: "/definitely/not/here", userConfirmed: false },
      "/definitely/not/here",
    );
    expect(v.status).not.toBe("stale");
    expect(v.status).toBe("sourced_unverified");
    // a real missing file is still stale
    const real = classifyProvenance(
      { files: ["gone.ts"], fileHashes: { "gone.ts": "ab" }, command: "Read", cwd: "/definitely/not/here", userConfirmed: false },
      "/definitely/not/here",
    );
    expect(real.status).toBe("stale");
  });

  it("a real path with brackets (a Next.js route) is still a file", () => {
    const prov = extractProvenance({
      cwd: "/repo",
      data: { tool_name: "Read", tool_input: { file_path: "/repo/app/[id]/page.tsx" } },
    });
    expect(prov.files).toEqual(["app/[id]/page.tsx"]);
  });
});

describe("extraction: the regression gate covers every tool family seen live", () => {
  const LIVE_TOOLS: Array<[string, Record<string, unknown>]> = [
    ["WebFetch", { url: "https://example.com/a" }],
    ["webfetch", { url: "https://example.com/b" }],
    ["WebSearch", { query: "q" }],
    ["web_search", { query: "q" }],
    ["Agent", { description: "d" }],
    ["run_subagent", { task: "t" }],
    ["mcp__claude_ai_Slack__slack_read_thread", { channel_id: "C1", message: "m" }],
    ["mcp__claude_ai_Slack__slack_search_public_and_private", { keywords: ["KubeAI"], natural_language_query: "inference demo" }],
    ["webrun", { search_query: [{ q: "KubeWorld github" }, { q: "ClusterWorld agent" }] }],
    ["Skill", { skill: "last30days:last30days", args: "agent memory" }],
  ];
  it("list-shaped queries are joined", () => {
    const c = buildSyntheticCompression(
      raw({ toolName: "webrun", toolInput: { search_query: [{ q: "KubeWorld github" }, { q: "ClusterWorld agent" }] } }),
    );
    expect(c.title).toBe('Searched web: "KubeWorld github | ClusterWorld agent"');
  });

  it("none of them is titled with its bare tool name", () => {
    for (const [toolName, toolInput] of LIVE_TOOLS) {
      const c = buildSyntheticCompression(raw({ toolName, toolInput }));
      expect(c.title).not.toBe(toolName);
    }
  });
});
