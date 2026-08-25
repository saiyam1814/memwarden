import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import {
  getSearchIndex,
  registerCoreFunctions,
  rememberMemory,
  transitionMemoryLifecycle,
} from "../src/functions/index.js";
import {
  applyMemoryLifecycleTransition,
  evaluateMemoryAsOf,
  initializeMemoryLifecycle,
  migrateLegacyMemoryLifecycle,
  persistedLifecycleOf,
} from "../src/functions/memory-lifecycle.js";
import { __resetColdRebuildForTests } from "../src/functions/search.js";
import { classifyProvenance, hashFiles } from "../src/functions/verify.js";
import type { CanonRecord, Memory } from "../src/functions/types.js";
import { exportBundle, importBundle } from "../src/bundle/bundle.js";
import {
  importCanonRecord,
  isCanonRecord,
} from "../src/functions/canon.js";
import {
  parseCanon,
  recordFromMemory,
  serializeCanon,
} from "../src/cli/canon.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { createMcpServer } from "../src/mcp/server.js";

const T0 = "2025-01-01T00:00:00.000Z";
const T1 = "2025-02-01T00:00:00.000Z";
const T2 = "2025-03-01T00:00:00.000Z";
const T3 = "2025-04-01T00:00:00.000Z";

function memoryFixture(id = "mem_lifecycle"): Memory {
  return {
    id,
    createdAt: T0,
    updatedAt: T0,
    type: "fact",
    title: "Lifecycle policy canary",
    content: "LIFECYCLE_POLICY_CANARY remains versioned.",
    concepts: ["lifecycle", "policy"],
    files: [],
    sessionIds: [],
    strength: 8,
    version: 1,
    isLatest: true,
    provenance: {
      command: "user confirmation",
      userConfirmed: true,
      capturedAt: T0,
    },
    ...initializeMemoryLifecycle(T0, "initial claim", "tester"),
  };
}

describe("typed Memory lifecycle state machine", () => {
  it("validates transitions and retains reasons plus every validity interval", () => {
    const initial = memoryFixture();
    const needsRevalidation = applyMemoryLifecycleTransition(initial, {
      action: "mark_needs_revalidation",
      reason: "manual review requested",
      at: T1,
    });
    expect(needsRevalidation).toMatchObject({
      lifecycle: "needs_revalidation",
      validTo: T1,
    });
    const revalidated = applyMemoryLifecycleTransition(needsRevalidation, {
      action: "revalidate",
      reason: "original evidence matches again",
      at: T2,
    });
    expect(revalidated).toMatchObject({
      lifecycle: "active",
      validFrom: T2,
    });

    const disputed = applyMemoryLifecycleTransition(initial, {
      action: "dispute",
      reason: "two maintainers disagree",
      at: T1,
      actor: "alice",
    });
    expect(disputed).toMatchObject({
      lifecycle: "disputed",
      validFrom: T0,
      validTo: T1,
      lifecycleReason: "two maintainers disagree",
    });
    expect(disputed.validityIntervals).toEqual([
      { validFrom: T0, validTo: T1, reason: "initial claim" },
    ]);

    const restored = applyMemoryLifecycleTransition(disputed, {
      action: "restore",
      reason: "dispute resolved with review",
      at: T2,
    });
    expect(restored.lifecycle).toBe("active");
    expect(restored.validFrom).toBe(T2);
    expect(restored.validTo).toBeUndefined();
    expect(restored.validityIntervals).toEqual([
      { validFrom: T0, validTo: T1, reason: "initial claim" },
      { validFrom: T2, reason: "dispute resolved with review" },
    ]);
    expect(restored.lifecycleTransitions?.map((item) => item.action)).toEqual([
      "create",
      "dispute",
      "restore",
    ]);

    expect(() =>
      applyMemoryLifecycleTransition(initial, {
        action: "restore",
        reason: "already active",
        at: T1,
      }),
    ).toThrow(/invalid lifecycle transition/);
    expect(() =>
      applyMemoryLifecycleTransition(initial, {
        action: "archive",
        reason: "time travel",
        at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow(/precede/);

    const superseded = applyMemoryLifecycleTransition(restored, {
      action: "supersede",
      reason: "new version",
      at: T3,
      supersededBy: "mem_v2",
    });
    expect(superseded).toMatchObject({
      lifecycle: "superseded",
      isLatest: false,
      supersededBy: "mem_v2",
      validTo: T3,
    });
    expect(() =>
      applyMemoryLifecycleTransition(superseded, {
        action: "restore",
        reason: "superseded content is immutable",
        at: "2025-05-01T00:00:00.000Z",
      }),
    ).toThrow(/invalid lifecycle transition/);
  });

  it("derives conservative legacy defaults without mutating the legacy object", () => {
    const legacy = memoryFixture("legacy");
    delete legacy.lifecycle;
    delete legacy.lifecycleReason;
    delete legacy.lifecycleChangedAt;
    delete legacy.lifecycleTransitions;
    delete legacy.observedAt;
    delete legacy.validFrom;
    delete legacy.validityIntervals;
    const before = JSON.stringify(legacy);

    expect(persistedLifecycleOf(legacy)).toBe("active");
    expect(evaluateMemoryAsOf(legacy, T1)).toMatchObject({
      available: true,
      active: true,
      reconstruction: "legacy_inferred",
    });
    expect(JSON.stringify(legacy)).toBe(before);

    const migrated = migrateLegacyMemoryLifecycle(legacy);
    expect(migrated).toMatchObject({
      lifecycle: "active",
      lifecycleMigratedFromLegacy: true,
      observedAt: T0,
      validFrom: T0,
    });
    expect(legacy.lifecycle).toBeUndefined();

    const malformed = {
      ...legacy,
      lifecycle: "active" as const,
      lifecycleTransitions: [
        {
          from: "active" as const,
          to: "active" as const,
          action: "restore" as const,
          at: T1,
          reason: "invalid no-op restore",
        },
      ],
    };
    expect(persistedLifecycleOf(malformed)).toBe("needs_revalidation");

    const old = { ...legacy, isLatest: false, updatedAt: T1 };
    expect(persistedLifecycleOf(old)).toBe("superseded");
    expect(evaluateMemoryAsOf(old, "2025-01-15T00:00:00.000Z").active).toBe(
      true,
    );
    expect(evaluateMemoryAsOf(old, T2).active).toBe(false);
  });
});

describe("lifecycle persistence, recall, and diagnostics", () => {
  let sdk: Kernel;
  let kv: StateKV;
  let root: string;

  beforeEach(() => {
    __resetKernelSingleton();
    __resetColdRebuildForTests();
    getSearchIndex().clear();
    sdk = registerWorker("in-process", { workerName: "memwarden-lifecycle" }, {
      store: new StoreMemory(),
    });
    kv = new StateKV(sdk);
    registerCoreFunctions(sdk, kv);
    root = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-lifecycle-")));
  });

  afterEach(async () => {
    await sdk.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    __resetKernelSingleton();
  });

  async function remember(args: {
    text: string;
    title: string;
    at: string;
    files?: string[];
    supersedes?: string;
  }): Promise<Memory> {
    const result = await rememberMemory(kv, {
      text: args.text,
      title: args.title,
      project: root,
      timestamp: args.at,
      files: args.files,
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
    });
    expect(result.success).toBe(true);
    return result.memory!;
  }

  async function search(payload: Record<string, unknown>): Promise<{
    mode?: string;
    results: Array<Record<string, unknown>>;
    text?: string;
    as_of?: Record<string, unknown>;
  }> {
    return sdk.trigger({
      function_id: "mem::search",
      payload: {
        query: "LIFECYCLE_POLICY_CANARY",
        cwd: root,
        limit: 20,
        ...payload,
      },
    });
  }

  it("projects source drift as needs_revalidation without a write-on-read", async () => {
    writeFileSync(join(root, "policy.ts"), "export const policy = 'v1';\n");
    const memory = await remember({
      text: "LIFECYCLE_POLICY_CANARY uses policy v1",
      title: "Versioned policy",
      at: T0,
      files: ["policy.ts"],
    });
    const before = await kv.get<Memory>(KV.memories, memory.id);
    expect(
      (await search({ mode: "current", format: "compact" })).results,
    ).toHaveLength(1);

    writeFileSync(join(root, "policy.ts"), "export const policy = 'v2';\n");
    expect(
      (await search({ mode: "current", format: "compact" })).results,
    ).toEqual([]);
    const historical = await search({ mode: "historical", format: "narrative" });
    expect(historical.results).toHaveLength(1);
    expect(historical.results[0]).toMatchObject({
      trust: "stale",
      evidence_trust: "verified",
      live_source_status: "drifted",
      persisted_lifecycle: "active",
      effective_lifecycle: "needs_revalidation",
      transition_reason: "manual memory created",
      historical: true,
    });
    expect(historical.text).toContain("[needs_revalidation]");
    expect(await kv.get<Memory>(KV.memories, memory.id)).toEqual(before);
  });

  it("supersedes without destroying the old version and supports exact as-of recall", async () => {
    const old = await remember({
      text: "LIFECYCLE_POLICY_CANARY used one-hour tokens",
      title: "Legacy token policy",
      at: T0,
    });
    const current = await remember({
      text: "LIFECYCLE_POLICY_CANARY now uses fifteen-minute tokens",
      title: "Current token policy",
      at: T1,
      supersedes: old.id,
    });

    expect(await kv.get<Memory>(KV.memories, old.id)).toMatchObject({
      lifecycle: "superseded",
      validFrom: T0,
      validTo: T1,
      supersededBy: current.id,
      isLatest: false,
    });
    expect(await kv.get<Memory>(KV.memories, current.id)).toMatchObject({
      lifecycle: "active",
      validFrom: T1,
      supersedes: [old.id],
    });

    const now = await search({ mode: "current", format: "full" });
    expect(now.results).toHaveLength(1);
    expect((now.results[0]!["observation"] as { id: string }).id).toBe(current.id);
    const history = await search({ mode: "historical", format: "compact" });
    expect(history.results).toHaveLength(1);
    expect(history.results[0]).toMatchObject({
      obsId: old.id,
      persisted_lifecycle: "superseded",
      superseded: true,
    });

    const before = await search({
      mode: "as_of",
      as_of: "2025-01-15T00:00:00.000Z",
      format: "compact",
    });
    expect(before.mode).toBe("as_of");
    expect(before.results).toHaveLength(1);
    expect(before.results[0]).toMatchObject({
      obsId: old.id,
      lifecycle_as_of: "active",
      as_of_reconstruction: "exact",
      source_status_temporality: "current-check-only",
    });
    const after = await search({
      mode: "as_of",
      as_of: "2025-02-15T00:00:00.000Z",
      format: "compact",
    });
    expect(after.results).toHaveLength(1);
    expect(after.results[0]!["obsId"]).toBe(current.id);
    expect(after.as_of).toMatchObject({
      reconstruction: "stored-validity-intervals-only",
      scan_cap: 2000,
    });
  });

  it("labels observation-only as-of history unavailable instead of using oplog commitments", async () => {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "as-of-observation",
        project: root,
        cwd: root,
        timestamp: T0,
        data: {
          tool_name: "Bash",
          tool_input: { command: "printf lifecycle" },
          tool_output: "LIFECYCLE_POLICY_CANARY observation-only history",
        },
      },
    });
    const result = await search({
      mode: "as_of",
      as_of: T1,
      format: "compact",
    });
    expect(result.results).toEqual([]);
    expect(result.as_of).toMatchObject({
      unavailable: 1,
      reconstruction: "stored-validity-intervals-only",
    });
    expect(String(result.as_of?.["note"])).toMatch(/commitments, not content history/);
  });

  it("records dispute/archive/revoke/restore and keeps non-active records historical", async () => {
    let memory = await remember({
      text: "LIFECYCLE_POLICY_CANARY can be contested",
      title: "Contested policy",
      at: T0,
    });
    for (const [action, at, state] of [
      ["dispute", T1, "disputed"],
      ["restore", T2, "active"],
      ["archive", T3, "archived"],
    ] as const) {
      const result = await transitionMemoryLifecycle(kv, {
        memoryId: memory.id,
        action,
        reason: `${action} because reviewed`,
        at,
      });
      expect(result.ok).toBe(true);
      memory = result.ok ? result.memory : memory;
      expect(memory.lifecycle).toBe(state);
    }
    expect((await search({ mode: "current" })).results).toEqual([]);
    expect((await search({ mode: "historical" })).results[0]).toMatchObject({
      persisted_lifecycle: "archived",
      effective_lifecycle: "archived",
      transition_reason: "archive because reviewed",
    });

    const restored = await transitionMemoryLifecycle(kv, {
      memoryId: memory.id,
      action: "restore",
      reason: "archive was premature",
      at: "2025-05-01T00:00:00.000Z",
    });
    expect(restored.ok).toBe(true);
    memory = restored.ok ? restored.memory : memory;
    const revoked = await transitionMemoryLifecycle(kv, {
      memoryId: memory.id,
      action: "revoke",
      reason: "owner explicitly revoked the claim",
      at: "2025-06-01T00:00:00.000Z",
    });
    expect(revoked.ok).toBe(true);
    expect(revoked.ok && revoked.memory.lifecycle).toBe("revoked");
    expect((await kv.list<Memory>(KV.memories))).toHaveLength(1);
  });

  it("revalidation creates a linked source version when capture hashes changed", async () => {
    writeFileSync(join(root, "policy.ts"), "export const policy = 'v1';\n");
    const original = await remember({
      text: "LIFECYCLE_POLICY_CANARY remains semantically valid",
      title: "Revalidatable policy",
      at: T0,
      files: ["policy.ts"],
    });
    const originalHash = original.provenance?.fileHashes?.["policy.ts"];
    writeFileSync(join(root, "policy.ts"), "export const policy = 'v2';\n");

    const result = await transitionMemoryLifecycle(kv, {
      memoryId: original.id,
      action: "revalidate",
      reason: "reviewed against policy v2",
      at: T1,
      root,
      actor: "reviewer",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.successor).toBeDefined();
    expect(result.memory).toMatchObject({
      id: original.id,
      lifecycle: "superseded",
      validTo: T1,
      supersededBy: result.successor!.id,
    });
    expect(result.memory.provenance?.fileHashes?.["policy.ts"]).toBe(originalHash);
    expect(result.successor).toMatchObject({
      lifecycle: "active",
      validFrom: T1,
      parentId: original.id,
      supersedes: [original.id],
      provenance: { cwd: root, capturedAt: T1 },
    });
    expect(result.successor!.provenance?.fileHashes?.["policy.ts"]).not.toBe(
      originalHash,
    );
    expect(await kv.list<Memory>(KV.memories)).toHaveLength(2);
    const current = await search({ mode: "current", format: "compact" });
    expect(current.results.map((item) => item["obsId"])).toEqual([
      result.successor!.id,
    ]);
  });

  it("doctor and why report evidence, source, lifecycle, validity, and reasons independently", async () => {
    writeFileSync(join(root, "policy.ts"), "export const policy = 'v1';\n");
    const memory = await remember({
      text: "LIFECYCLE_POLICY_CANARY diagnostic claim",
      title: "Diagnostic policy",
      at: T0,
      files: ["policy.ts"],
    });
    writeFileSync(join(root, "policy.ts"), "export const policy = 'v2';\n");

    const doctor = await sdk.trigger<
      { root: string; project: string },
      {
        evidence: Record<string, number>;
        source: Record<string, number>;
        lifecycle: Record<string, Array<Record<string, unknown>>>;
      }
    >({
      function_id: "mem::doctor",
      payload: { root, project: root },
    });
    expect(doctor.evidence.verified).toBe(1);
    expect(doctor.source.drifted).toBe(1);
    expect(doctor.lifecycle.needs_revalidation[0]).toMatchObject({
      id: memory.id,
      persistedLifecycle: "active",
      effectiveLifecycle: "needs_revalidation",
      transitionReason: "manual memory created",
      validFrom: T0,
    });

    const why = await sdk.trigger<
      { observationId: string; root: string },
      {
        injectable: boolean;
        evidenceVerdict: { status: string };
        sourceStatus: { status: string };
        lifecycle: {
          persisted: string;
          effective: string;
          transitionReason: string;
        };
        validity: { validFrom: string };
      }
    >({
      function_id: "mem::why",
      payload: { observationId: memory.id, root },
    });
    expect(why).toMatchObject({
      injectable: false,
      evidenceVerdict: { status: "verified" },
      sourceStatus: { status: "drifted" },
      lifecycle: {
        persisted: "active",
        effective: "needs_revalidation",
        transitionReason: "manual memory created",
      },
      validity: { validFrom: T0 },
    });
  });

  it("Brain Bundle and Canon round-trip lifecycle, validity, lineage, and separate attestation", async () => {
    writeFileSync(join(root, "policy.ts"), "export const policy = 'v1';\n");
    const active = await remember({
      text: "LIFECYCLE_POLICY_CANARY portable claim",
      title: "Portable policy",
      at: T0,
      files: ["policy.ts"],
    });
    active.sourceCommit = "abc123def456";
    active.parentId = "mem_lineage_root";
    active.relatedIds = ["mem_related"];
    await kv.set(KV.memories, active.id, active);
    const archivedResult = await transitionMemoryLifecycle(kv, {
      memoryId: active.id,
      action: "archive",
      reason: "retained for historical reference",
      at: T1,
    });
    expect(archivedResult.ok).toBe(true);
    if (!archivedResult.ok) return;
    const archived = archivedResult.memory;

    const bundle = await exportBundle(kv);
    expect(bundle.memories[0]).toEqual(archived);
    await kv.delete(KV.memories, archived.id);
    await importBundle(kv, bundle);
    expect(await kv.get<Memory>(KV.memories, archived.id)).toEqual(archived);

    const record = recordFromMemory(archived, root, T2);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      lifecycle: "archived",
      validFrom: T0,
      validTo: T1,
      version: archived.version,
      sourceCommit: "abc123def456",
      parentId: "mem_lineage_root",
      relatedIds: ["mem_related"],
    });
    const parsed = parseCanon(serializeCanon([record!])).records[0]!;
    expect(isCanonRecord(parsed)).toBe(true);
    expect(parsed.lifecycleTransitions).toEqual(archived.lifecycleTransitions);

    // Canon attestation is provenance metadata; local source verification
    // remains a separate classifier result.
    await kv.delete(KV.memories, archived.id);
    const reanchoredRecord: CanonRecord = {
      ...parsed,
      reanchoredBy: "reviewer",
      reanchoredAt: T2,
    };
    const imported = await importCanonRecord(kv, {
      root,
      record: reanchoredRecord,
    });
    expect(imported).toMatchObject({
      ok: true,
      verdict: "verified",
      lifecycle: "archived",
      attestation: "canon-reanchored",
    });
    const stored = await kv.get<Memory>(KV.memories, parsed.id);
    expect(stored).toMatchObject({
      lifecycle: "archived",
      validFrom: T0,
      validTo: T1,
      sourceCommit: "abc123def456",
      parentId: "mem_lineage_root",
      relatedIds: ["mem_related"],
      provenance: {
        canon: {
          recordId: parsed.id,
          promotedAt: parsed.promotedAt,
          reanchoredBy: "reviewer",
          reanchoredAt: T2,
        },
      },
    });
    const verdict = classifyProvenance(stored!.provenance, root, {
      verifyAgainstRoot: true,
    });
    expect(verdict).toMatchObject({
      evidenceTrust: "verified",
      sourceStatus: "matched",
    });
  });

  it("keeps mixed records conservatively sourced even when listed hashes match", () => {
    writeFileSync(join(root, "policy.ts"), "export const policy = 'v1';\n");
    const provenance = {
      cwd: root,
      files: ["policy.ts"],
      fileHashes: hashFiles(["policy.ts"], root),
      mixedTrust: true as const,
    };
    expect(classifyProvenance(provenance, root)).toMatchObject({
      status: "sourced_unverified",
      evidenceTrust: "sourced",
      sourceStatus: "matched",
    });
  });

  it("verified-only affects current trust policy but not explicit historical inspection", async () => {
    const memory = await remember({
      text: "LIFECYCLE_POLICY_CANARY command-backed policy",
      title: "Sourced policy",
      at: T0,
    });
    const prior = process.env.MEMWARDEN_RECALL_POLICY;
    try {
      process.env.MEMWARDEN_RECALL_POLICY = "verified-only";
      expect((await search({ mode: "current" })).results).toEqual([]);
      const archived = await transitionMemoryLifecycle(kv, {
        memoryId: memory.id,
        action: "archive",
        reason: "policy retired",
        at: T1,
      });
      expect(archived.ok).toBe(true);
      const history = await search({ mode: "historical", format: "compact" });
      expect(history.results[0]).toMatchObject({
        evidence_trust: "sourced",
        persisted_lifecycle: "archived",
      });
    } finally {
      if (prior === undefined) delete process.env.MEMWARDEN_RECALL_POLICY;
      else process.env.MEMWARDEN_RECALL_POLICY = prior;
    }
  });
});

describe("authenticated lifecycle HTTP boundary", () => {
  let sdk: Kernel;
  let kv: StateKV;
  let http: RunningHttpServer;
  let base: string;
  let root: string;
  let memory: Memory;

  beforeEach(async () => {
    __resetKernelSingleton();
    __resetColdRebuildForTests();
    getSearchIndex().clear();
    root = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-lifecycle-api-")));
    mkdirSync(join(root, "src"), { recursive: true });
    sdk = registerWorker("in-process", { workerName: "memwarden-lifecycle-api" }, {
      store: new StoreMemory(),
    });
    kv = new StateKV(sdk);
    registerCoreFunctions(sdk, kv);
    registerApiTriggers(sdk, "lifecycle-secret");
    const saved = await rememberMemory(kv, {
      text: "LIFECYCLE_POLICY_CANARY API claim",
      title: "API lifecycle claim",
      project: root,
      timestamp: T0,
    });
    memory = saved.memory!;
    http = startHttpServer(sdk, { port: 0 });
    await once(http.server, "listening");
    base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}/memwarden`;
  });

  afterEach(async () => {
    await http.close().catch(() => undefined);
    await sdk.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    __resetKernelSingleton();
  });

  async function post(authenticated: boolean, body: unknown): Promise<Response> {
    return fetch(`${base}/lifecycle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated
          ? { authorization: "Bearer lifecycle-secret" }
          : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("exposes the authenticated transition and historical query through MCP", async () => {
    const client = createMcpServer({
      baseUrl: base.replace(/\/memwarden$/, ""),
      cwd: root,
      secret: "lifecycle-secret",
    });
    const listed = await client.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (listed!.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.some((tool) => tool.name === "memory_lifecycle")).toBe(true);

    const transitioned = await client.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "memory_lifecycle",
        arguments: {
          memory_id: memory.id,
          action: "dispute",
          reason: "MCP reviewer disputes this claim",
        },
      },
    });
    const transitionText = (
      transitioned!.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(JSON.parse(transitionText)).toMatchObject({
      ok: true,
      memory: { lifecycle: "disputed" },
    });
    expect(transitionText).not.toContain("LIFECYCLE_POLICY_CANARY API claim");

    const searched = await client.dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: {
          query: "LIFECYCLE_POLICY_CANARY API claim",
          mode: "historical",
          format: "compact",
        },
      },
    });
    const searchText = (
      searched!.result as { content: Array<{ text: string }> }
    ).content[0]!.text;
    expect(JSON.parse(searchText)).toMatchObject({
      mode: "historical",
      results: [{ persisted_lifecycle: "disputed" }],
    });
  });

  it("requires authentication, a bounded reason, and a valid transition", async () => {
    const body = {
      memory_id: memory.id,
      action: "archive",
      reason: "reviewed and retired",
      at: T1,
    };
    expect((await post(false, body)).status).toBe(401);
    const response = await post(true, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      memory: { lifecycle: "archived", lifecycleReason: body.reason },
    });
    expect(
      (
        await post(true, {
          memory_id: memory.id,
          action: "archive",
          reason: "x".repeat(1001),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(true, {
          memory_id: memory.id,
          action: "revalidate",
          reason: "already archived",
          root,
        })
      ).status,
    ).toBe(409);
  });
});
