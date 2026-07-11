//
// SESSION JOURNALS — deliverable A. Prompts and session-end handoffs are
// first-class memory:
//   - buildSyntheticCompression treats a user prompt as intent (title = first
//     line, narrative = the prompt), never as a clipped tool trace.
//   - buildSessionHandoff deterministically synthesizes goal / what happened /
//     decisions / open threads from stored observations (pure, no LLM).
//   - mem::observe wires both: hookType "user_prompt" stores a capped,
//     secret-redacted prompt; hookType "session_end" persists the handoff on
//     Session.summary, KV.summaries, AND as a searchable observation.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  registerCoreFunctions,
  getSearchIndex,
} from "../src/functions/index.js";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";
import {
  buildSessionHandoff,
  MAX_STORED_PROMPT_CHARS,
} from "../src/functions/handoff.js";
import type { RawObservation, Session, SessionSummary } from "../src/functions/types.js";

// --- pure: prompt-first compression -----------------------------------

function rawPrompt(prompt: string): RawObservation {
  return {
    id: "obs_p1",
    sessionId: "s1",
    timestamp: "2026-07-11T10:00:00.000Z",
    hookType: "user_prompt",
    userPrompt: prompt,
    raw: { prompt },
  };
}

describe("buildSyntheticCompression — prompts are first-class", () => {
  it("title is the intent-ish first line, narrative is the prompt", () => {
    const c = buildSyntheticCompression(
      rawPrompt("Fix the flaky auth test\n\nIt fails on CI only, see run 812."),
    );
    expect(c.type).toBe("conversation");
    expect(c.title).toBe("Fix the flaky auth test");
    expect(c.narrative).toContain("It fails on CI only");
    expect(c.narrative.startsWith("Fix the flaky auth test")).toBe(true);
    expect(c.importance).toBeGreaterThan(5); // above the tool-trace default
  });

  it("clips a very long prompt but keeps the head (where intent lives)", () => {
    const c = buildSyntheticCompression(rawPrompt("refactor everything " .repeat(200)));
    expect(c.narrative.length).toBeLessThanOrEqual(600);
    expect(c.narrative.startsWith("refactor everything")).toBe(true);
  });

  it("tool traces still compress exactly as before (no prompt involved)", () => {
    const c = buildSyntheticCompression({
      id: "obs_t1",
      sessionId: "s1",
      timestamp: "2026-07-11T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolOutput: "all green",
      raw: {},
    });
    expect(c.type).toBe("command_run");
    expect(c.title).toBe("Bash");
    expect(c.narrative).toContain("npm test");
  });
});

// --- pure: handoff synthesis -------------------------------------------

const T = "2026-07-11T18:00:00.000Z";

describe("buildSessionHandoff (deterministic, no LLM)", () => {
  it("synthesizes goal / what happened / decisions / open threads", () => {
    const h = buildSessionHandoff({
      obsId: "obs_end",
      sessionId: "sess-1",
      timestamp: T,
      project: "/work/app",
      firstPrompt: "Add rate limiting to the API",
      agentId: "claude-code",
      observations: [
        { type: "conversation", userPrompt: "Add rate limiting to the API" },
        { type: "file_edit", title: "Edit", files: ["src/limiter.ts"], narrative: "wrote limiter" },
        { type: "command_run", title: "Bash", narrative: "npm test | all green" },
        {
          type: "conversation",
          userPrompt: "we decided to use a token bucket instead of sliding window",
        },
        { type: "file_edit", title: "Edit", files: ["src/api.ts"], narrative: "wired limiter" },
      ],
    });

    expect(h.summaryText).toContain("Goal: Add rate limiting to the API");
    expect(h.summaryText).toContain("file edits");
    expect(h.summaryText).toContain("src/limiter.ts");
    expect(h.summaryText).toContain("Decisions:");
    expect(h.summaryText).toContain("token bucket");
    expect(h.summaryText).toContain("Open threads: none detected");

    expect(h.observation.id).toBe("obs_end");
    expect(h.observation.type).toBe("task");
    expect(h.observation.title).toContain("Session handoff:");
    expect(h.observation.title).toContain("Add rate limiting");
    expect(h.observation.files).toContain("src/api.ts");
    expect(h.observation.importance).toBe(8);
    expect(h.observation.agentId).toBe("claude-code");

    expect(h.sessionSummary.keyDecisions.length).toBe(1);
    expect(h.sessionSummary.project).toBe("/work/app");
    expect(h.sessionSummary.observationCount).toBe(5);
  });

  it("an error the session ended on is an open thread; earlier errors are not", () => {
    const worked = { type: "file_edit", title: "Edit", files: ["a.ts"] };
    const h = buildSessionHandoff({
      obsId: "o",
      sessionId: "s",
      timestamp: T,
      observations: [
        { type: "error", title: "npm test: TypeError early" },
        worked, worked, worked, worked, worked, // pushes the early error out of the tail
        { type: "error", title: "npm test: token refresh still failing" },
      ],
    });
    expect(h.summaryText).toContain("unresolved: npm test: token refresh still failing");
    expect(h.summaryText).not.toContain("TypeError early");
  });

  it("prompts naming future work become open threads", () => {
    const h = buildSessionHandoff({
      obsId: "o",
      sessionId: "s",
      timestamp: T,
      observations: [
        { type: "conversation", userPrompt: "ship it, but TODO: add docs for the limiter later" },
      ],
    });
    expect(h.summaryText).toContain("asked for later:");
  });

  it("a prompt ABOUT an error is not itself an unresolved error", () => {
    const h = buildSessionHandoff({
      obsId: "o",
      sessionId: "s",
      timestamp: T,
      observations: [
        { type: "conversation", userPrompt: "why does the build print error: EACCES?" },
        { type: "file_edit", title: "Edit", files: ["a.ts"] },
      ],
    });
    expect(h.summaryText).toContain("Open threads: none detected");
  });

  it("empty session still yields an honest handoff", () => {
    const h = buildSessionHandoff({
      obsId: "o",
      sessionId: "sess-empty",
      timestamp: T,
      observations: [],
    });
    expect(h.summaryText).toContain("Goal: (no prompt captured)");
    expect(h.summaryText).toContain("no activity captured");
  });

  it("is deterministic: same input, same output", () => {
    const input = {
      obsId: "o",
      sessionId: "s",
      timestamp: T,
      firstPrompt: "do the thing",
      observations: [{ type: "command_run", title: "Bash", narrative: "ls" }],
    };
    expect(buildSessionHandoff(input)).toEqual(buildSessionHandoff(input));
  });
});

// --- integration: mem::observe wiring -----------------------------------

let sdk: Kernel;
let kv: StateKV;

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  const store = new StoreMemory();
  sdk = registerWorker("in-process", { workerName: "memwarden-fn" }, { store });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
});

afterEach(() => {
  __resetKernelSingleton();
});

function payload(over: Record<string, unknown> = {}) {
  return {
    hookType: "post_tool_use",
    sessionId: "sess-J",
    project: "/work/journal",
    cwd: "/work/journal",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Edit",
      tool_input: { file_path: "src/limiter.ts" },
      tool_output: "ok",
    },
    ...over,
  };
}

describe("mem::observe hookType user_prompt", () => {
  it("stores the prompt, sets firstPrompt, and is keyword-searchable", async () => {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: payload({
        hookType: "user_prompt",
        data: { prompt: "Implement exponential backoff for the webhook retrier" },
      }),
    });

    const session = await kv.get<Session>(KV.sessions, "sess-J");
    expect(session?.firstPrompt).toContain("exponential backoff");

    const res = await sdk.trigger<
      unknown,
      { results: Array<{ observation: { type: string; title: string; narrative: string } }> }
    >({ function_id: "mem::search", payload: { query: "webhook backoff" } });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0]?.observation.type).toBe("conversation");
    expect(res.results[0]?.observation.title).toContain("exponential backoff");
  });

  it("caps stored prompt length", async () => {
    const huge = "a".repeat(MAX_STORED_PROMPT_CHARS + 5000);
    await sdk.trigger({
      function_id: "mem::observe",
      payload: payload({ hookType: "user_prompt", data: { prompt: huge } }),
    });
    const obs = await kv.list<{ narrative?: string }>(KV.observations("sess-J"));
    // Everything persisted stays within the cap (raw got overwritten by the
    // synthetic; narrative has its own tighter clip).
    expect(JSON.stringify(obs).length).toBeLessThan(MAX_STORED_PROMPT_CHARS + 2000);
  });

  it("redacts secrets in prompts (same privacy path as tool output)", async () => {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: payload({
        hookType: "user_prompt",
        data: { prompt: "use key sk-ant-abcdefghijklmnopqrstuvwxyz01 for the deploy" },
      }),
    });
    const serialized = JSON.stringify(await kv.list(KV.observations("sess-J")));
    expect(serialized).not.toContain("sk-ant-abcdefghij");
    expect(serialized).toContain("REDACTED_SECRET");
  });

  it("two DIFFERENT prompts in quick succession are both stored (no dedup collision)", async () => {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: payload({ hookType: "user_prompt", data: { prompt: "first ask" } }),
    });
    const second = await sdk.trigger<unknown, { observationId?: string; deduplicated?: boolean }>({
      function_id: "mem::observe",
      payload: payload({ hookType: "user_prompt", data: { prompt: "second ask" } }),
    });
    expect(second.deduplicated).toBeUndefined();
    expect(await kv.list(KV.observations("sess-J"))).toHaveLength(2);
  });

  it("an identical retried prompt IS deduplicated", async () => {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: payload({ hookType: "user_prompt", data: { prompt: "same ask" } }),
    });
    const second = await sdk.trigger<unknown, { deduplicated?: boolean }>({
      function_id: "mem::observe",
      payload: payload({ hookType: "user_prompt", data: { prompt: "same ask" } }),
    });
    expect(second).toMatchObject({ deduplicated: true });
  });
});

describe("mem::observe hookType session_end (handoff summary)", () => {
  async function runSession() {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: payload({
        hookType: "user_prompt",
        data: { prompt: "Add caching to the geodata fetcher" },
      }),
    });
    await sdk.trigger({
      function_id: "mem::observe",
      payload: payload({
        data: {
          tool_name: "Edit",
          tool_input: { file_path: "src/geodata.ts" },
          tool_output: "we chose an LRU cache instead of a plain map",
        },
      }),
    });
    return sdk.trigger<unknown, { observationId?: string }>({
      function_id: "mem::observe",
      payload: payload({
        hookType: "session_end",
        timestamp: "2026-07-11T19:00:00.000Z",
        data: { reason: "prompt_input_exit" },
      }),
    });
  }

  it("persists the handoff on Session.summary and completes the session", async () => {
    await runSession();
    const session = await kv.get<Session>(KV.sessions, "sess-J");
    expect(session?.status).toBe("completed");
    expect(session?.endedAt).toBe("2026-07-11T19:00:00.000Z");
    expect(session?.summary).toContain("Goal: Add caching to the geodata fetcher");
    expect(session?.summary).toContain("src/geodata.ts");
  });

  it("writes a SessionSummary that mem::context can render", async () => {
    await runSession();
    const summary = await kv.get<SessionSummary>(KV.summaries, "sess-J");
    expect(summary?.title).toContain("Session handoff:");
    expect(summary?.narrative).toContain("Goal:");
    expect(summary?.filesModified).toContain("src/geodata.ts");
  });

  it("the handoff is a searchable observation (cross-tool recall path)", async () => {
    const r = await runSession();
    expect(r.observationId).toMatch(/^obs_/);
    const res = await sdk.trigger<
      unknown,
      { results: Array<{ observation: { id: string; type: string; title: string } }> }
    >({ function_id: "mem::search", payload: { query: "handoff geodata caching" } });
    const hit = res.results.find((x) => x.observation.id === r.observationId);
    expect(hit).toBeDefined();
    expect(hit?.observation.type).toBe("task");
    expect(hit?.observation.title).toContain("Session handoff:");
  });

  it("captures decision language from tool output in the handoff", async () => {
    await runSession();
    const session = await kv.get<Session>(KV.sessions, "sess-J");
    expect(session?.summary).toContain("Decisions:");
    expect(session?.summary).toContain("LRU cache");
  });

  it("session_end with no session row still stores a handoff observation", async () => {
    const r = await sdk.trigger<unknown, { observationId?: string }>({
      function_id: "mem::observe",
      payload: {
        hookType: "session_end",
        sessionId: "sess-ghost",
        timestamp: "2026-07-11T19:00:00.000Z",
        data: { reason: "other" },
      },
    });
    expect(r.observationId).toMatch(/^obs_/);
    const obs = await kv.list<{ title?: string }>(KV.observations("sess-ghost"));
    expect(obs).toHaveLength(1);
    expect(obs[0]?.title).toContain("Session handoff:");
  });
});
