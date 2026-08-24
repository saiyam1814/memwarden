//
// Canon's core/API boundary: exact project-scoped Memory inventory and a
// dedicated import that can only create hash-verified provenance after checking
// this checkout. These tests intentionally bypass semantic search/observe.
//

import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetKernelSingleton,
  registerWorker,
  startHttpServer,
  type Kernel,
  type RunningHttpServer,
} from "../src/kernel/index.js";
import {
  getSearchIndex,
  registerCoreFunctions,
} from "../src/functions/index.js";
import { projectKey } from "../src/functions/git-identity.js";
import type { CanonRecord, Memory } from "../src/functions/types.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { registerApiTriggers } from "../src/triggers/api.js";

let sdk: Kernel;
let kv: StateKV;
let http: RunningHttpServer;
let base: string;
let temp: string;
let repoA: string;
let repoB: string;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeRepo(name: string, remote: string): string {
  const root = join(temp, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(
    join(root, ".git", "config"),
    `[remote "origin"]\n\turl = ${remote}\n`,
    "utf8",
  );
  return realpathSync(root);
}

function memory(id: string, root: string, content = id): Memory {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    type: "architecture",
    title: `Title ${id}`,
    content,
    concepts: [id],
    files: ["src/source.ts"],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
    project: root,
    projectKey: projectKey(root),
    provenance: {
      cwd: root,
      files: ["src/source.ts"],
      fileHashes: { "src/source.ts": "a".repeat(64) },
    },
  };
}

function canonRecord(root: string, id = "mem_import"): CanonRecord {
  const source = "export const answer = 42;\n";
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/source.ts"), source, "utf8");
  return {
    format: 1,
    id,
    type: "architecture",
    projectKey: projectKey(root),
    title: "The exact imported title",
    content: "The exact imported content says answer is 42.",
    concepts: ["answer", "canon"],
    files: ["src/source.ts"],
    fileHashes: { "src/source.ts": sha256(source) },
    capturedBy: { host: "claude-code", agentId: "agent-7" },
    promotedAt: "2025-01-02T03:04:05.000Z",
    reanchoredBy: "alice",
    reanchoredAt: "2025-02-03T04:05:06.000Z",
  };
}

async function post(
  path: string,
  body: unknown,
  authenticated = true,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: "Bearer canon-test-secret" } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  temp = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-canon-api-")));
  repoA = makeRepo("a", "git@github.com:acme/project-a.git");
  repoB = makeRepo("b", "git@github.com:acme/project-b.git");

  sdk = registerWorker("in-process", { workerName: "memwarden-canon-api" }, {
    store: new StoreMemory(),
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  registerApiTriggers(sdk, "canon-test-secret");
  http = startHttpServer(sdk, { port: 0 });
  await once(http.server, "listening");
  base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}/memwarden`;
});

afterEach(async () => {
  await http.close().catch(() => undefined);
  await sdk.shutdown();
  rmSync(temp, { recursive: true, force: true });
  __resetKernelSingleton();
});

describe("Canon core/API boundary", () => {
  it("pages real Memory rows for one exact project identity, never search results", async () => {
    await kv.set(KV.memories, "mem_a1", memory("mem_a1", repoA));
    await kv.set(KV.memories, "mem_a2", memory("mem_a2", repoA));
    await kv.set(KV.memories, "mem_b", memory("mem_b", repoB));

    const first = await post("/canon/export", { root: repoA, limit: 1 });
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      project: { root: string; key: string };
      memories: Memory[];
      nextCursor?: string;
    };
    expect(page1.project).toEqual({ root: repoA, key: projectKey(repoA) });
    expect(page1.memories.map((m) => m.id)).toEqual(["mem_a1"]);
    expect(page1.memories[0]!.title).toBe("Title mem_a1");
    expect(page1.nextCursor).toBe("mem_a1");

    const second = await post("/canon/export", {
      root: repoA,
      limit: 1,
      cursor: page1.nextCursor,
    });
    const page2 = (await second.json()) as { memories: Memory[]; nextCursor?: string };
    expect(page2.memories.map((m) => m.id)).toEqual(["mem_a2"]);
    expect(page2.nextCursor).toBeUndefined();
    expect(page2.memories.some((m) => m.id === "mem_b")).toBe(false);
  });

  it("imports exact content/evidence/project/attestation only after local hash matching", async () => {
    const record = canonRecord(repoA);
    const response = await post("/canon/import", { root: repoA, record });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      imported: true,
      id: record.id,
      projectKey: record.projectKey,
      verdict: "verified",
    });

    const stored = await kv.get<Memory>(KV.memories, record.id);
    expect(stored).toMatchObject({
      id: record.id,
      type: record.type,
      title: record.title,
      content: record.content,
      concepts: record.concepts,
      files: record.files,
      project: repoA,
      projectKey: record.projectKey,
      agentId: "agent-7",
      provenance: {
        cwd: repoA,
        files: record.files,
        fileHashes: record.fileHashes,
        agent: "claude-code",
        canon: {
          format: 1,
          recordId: record.id,
          projectKey: record.projectKey,
          promotedAt: record.promotedAt,
          capturedBy: record.capturedBy,
          reanchoredBy: record.reanchoredBy,
          reanchoredAt: record.reanchoredAt,
        },
      },
    });
  });

  it("rejects caller-claimed verification when hashes do not match, even via the core id", async () => {
    const record = canonRecord(repoA, "mem_forged");
    const forged = {
      ...record,
      fileHashes: { "src/source.ts": "b".repeat(64) },
      verified: true,
      verdict: "verified",
    };

    const response = await post("/canon/import", { root: repoA, record: forged });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "hash_mismatch",
    });
    expect(await kv.get(KV.memories, record.id)).toBeNull();

    const direct = await sdk.trigger<
      { root: string; record: unknown },
      { ok: boolean; code?: string }
    >({
      function_id: "mem::canon-import",
      payload: { root: repoA, record: forged },
    });
    expect(direct).toMatchObject({ ok: false, code: "hash_mismatch" });
    expect(await kv.get(KV.memories, record.id)).toBeNull();
  });

  it("rejects a valid record from a different project identity", async () => {
    const record = canonRecord(repoA, "mem_wrong_project");
    const response = await post("/canon/import", { root: repoB, record });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "project_mismatch",
    });
    expect(await kv.get(KV.memories, record.id)).toBeNull();
  });

  it("keeps both Canon routes behind the existing bearer-secret gate", async () => {
    expect((await post("/canon/export", { root: repoA }, false)).status).toBe(401);
    expect(
      (await post("/canon/import", { root: repoA, record: canonRecord(repoA) }, false))
        .status,
    ).toBe(401);
  });
});
