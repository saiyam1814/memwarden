//
// Session-start recall ranks by recency, not by similarity to a fixed
// sentence. The old query ("recent work and decisions in this project")
// injected whatever contained the word "project": old prompts and grep
// patterns. rank=recent puts the latest handoffs first (even when older than
// the newest captures), then the newest candidates of the requested types,
// and changes nothing about scope, classification, or the firewall.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreMemory } from "../src/state/store-memory.js";
import { registerWorker, __resetKernelSingleton, type Kernel } from "../src/kernel/index.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import type { CompressedObservation, Session } from "../src/functions/types.js";

let sdk: Kernel;
let kv: StateKV;
let repo: string;

beforeEach(async () => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-brief" }, { store: new StoreMemory() });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  repo = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-brief-")));
  writeFileSync(join(repo, "a.ts"), "export const A = 1;\n");
  const session: Session = {
    id: "s-brief",
    project: repo,
    cwd: repo,
    startedAt: "2026-09-01T00:00:00.000Z",
    status: "active",
    observationCount: 0,
  };
  await kv.set(KV.sessions, session.id, session);
});

afterEach(() => {
  __resetKernelSingleton();
  rmSync(repo, { recursive: true, force: true });
});

async function put(id: string, type: CompressedObservation["type"], ts: string, extra: Partial<CompressedObservation> = {}) {
  const obs: CompressedObservation = {
    id,
    sessionId: "s-brief",
    timestamp: ts,
    type,
    title: `${type} ${id}`,
    facts: [],
    narrative: `${type} ${id} narrative about the project`,
    concepts: [],
    files: [],
    importance: 5,
    provenance: { cwd: repo, command: "Bash: x", userConfirmed: false },
    ...extra,
  };
  await kv.set(KV.observations("s-brief"), id, obs);
  getSearchIndex().add(obs);
}

async function brief(types?: string[]) {
  return sdk.trigger<unknown, { results: Array<{ obsId?: string; observation?: { id: string }; id?: string }> }>({
    function_id: "mem::search",
    payload: {
      query: "recent work and decisions in this project",
      rank: "recent",
      ...(types ? { types } : {}),
      cwd: repo,
      project: repo,
      safe_only: true,
      limit: 10,
    },
  });
}

const idsOf = (r: { results: unknown[] }) =>
  r.results.map((x) => JSON.stringify(x).match(/"(?:obsId|id)":"(o-[^"]+)"/)?.[1]);

describe("rank=recent", () => {
  it("orders newest first, with the latest two handoffs up front even when older", async () => {
    await put("o-handoff-old", "task", "2026-09-01T00:00:00.000Z");
    await put("o-handoff-mid", "task", "2026-09-02T00:00:00.000Z");
    await put("o-handoff-new", "task", "2026-09-03T00:00:00.000Z");
    await put("o-edit-1", "file_edit", "2026-09-10T00:00:00.000Z");
    await put("o-edit-2", "file_edit", "2026-09-11T00:00:00.000Z");
    await put("o-prompt", "conversation", "2026-09-12T00:00:00.000Z");
    const r = await brief(["task", "file_edit"]);
    expect(idsOf(r)).toEqual(["o-handoff-new", "o-handoff-mid", "o-edit-2", "o-edit-1"]);
  });

  it("still runs the firewall: a stale recent edit is refused", async () => {
    const hash = "0".repeat(64); // never matches a.ts
    await put("o-edit-stale", "file_edit", "2026-09-11T00:00:00.000Z", {
      provenance: { cwd: repo, files: ["a.ts"], fileHashes: { "a.ts": hash }, command: "Edit", userConfirmed: false },
    });
    await put("o-edit-ok", "file_edit", "2026-09-10T00:00:00.000Z");
    const r = (await brief(["file_edit"])) as { results: unknown[]; firewall?: { refused?: number } };
    expect(idsOf(r)).toEqual(["o-edit-ok"]);
    expect(r.firewall?.refused).toBe(1);
  });

  it("rejects an unknown rank and a malformed types list", async () => {
    await expect(
      sdk.trigger({ function_id: "mem::search", payload: { query: "x", rank: "loudest" } }),
    ).rejects.toThrow(/rank/);
    await expect(
      sdk.trigger({ function_id: "mem::search", payload: { query: "x", types: "task" } }),
    ).rejects.toThrow(/types/);
  });
});
