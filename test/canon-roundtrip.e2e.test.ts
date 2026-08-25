//
// Production regression for #54: real CLI processes -> authenticated-compatible
// HTTP routes -> core store, then a fresh on-disk brain and the reverse path.
// Helper-only serialization tests cannot prove these layers compose.
//

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetKernelSingleton,
  registerWorker,
  startHttpServer,
  type Kernel,
  type RunningHttpServer,
} from "../src/kernel/index.js";
import { getSearchIndex, registerCoreFunctions } from "../src/functions/index.js";
import { projectKey } from "../src/functions/git-identity.js";
import type { CanonRecord, Memory } from "../src/functions/types.js";
import { readCanon, writeCanon } from "../src/cli/canon.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { registerApiTriggers } from "../src/triggers/api.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PROJECT_ROOT, "src/cli/bin.ts");
const TSX_CLI = join(PROJECT_ROOT, "node_modules/tsx/dist/cli.mjs");

let temp: string;
let repo: string;
let firstData: string;
let freshData: string;
let sdk: Kernel | undefined;
let kv: StateKV;
let http: RunningHttpServer | undefined;
let daemonUrl: string;
let priorDataDir: string | undefined;
let priorRecallPolicy: string | undefined;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function stopStack(): Promise<void> {
  if (http) await http.close().catch(() => undefined);
  if (sdk) await sdk.shutdown().catch(() => undefined);
  http = undefined;
  sdk = undefined;
  __resetKernelSingleton();
}

async function bootStack(dataDir: string): Promise<void> {
  await stopStack();
  process.env.MEMWARDEN_DATA_DIR = dataDir;
  getSearchIndex().clear();
  mkdirSync(dataDir, { recursive: true });
  const store = new StoreLibsql({ url: `file:${join(dataDir, "memwarden.db")}` });
  sdk = registerWorker("in-process", { workerName: "memwarden-canon-roundtrip" }, {
    store,
  });
  kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  // Empty secret is the production "open local daemon" mode. Dedicated API
  // tests separately prove these routes retain bearer middleware when enabled.
  registerApiTriggers(sdk, "");
  http = startHttpServer(sdk, { port: 0 });
  await once(http.server, "listening");
  daemonUrl = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
}

async function runCli(
  dataDir: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      MEMWARDEN_URL: daemonUrl,
      MEMWARDEN_DATA_DIR: dataDir,
      MEMWARDEN_SECRET: "",
      MEMWARDEN_EMBEDDING_PROVIDER: "none",
      MEMWARDEN_RECALL_POLICY: "verified-only",
    },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${daemonUrl}/memwarden${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function captureFile(
  file: string,
  output: string,
  sessionPrefix: string,
): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const response = await post("/observe", {
      hookType: "post_tool_use",
      sessionId: `${sessionPrefix}-${i}`,
      project: repo,
      cwd: repo,
      timestamp: new Date(Date.now() + i).toISOString(),
      agent: "claude-code",
      data: {
        tool_name: "Read",
        // Equivalent support arrives in distinct sessions. Claim-level
        // consolidation intentionally preserves differing tool inputs.
        tool_input: { file_path: file },
        tool_output: output,
      },
    });
    expect(response.status).toBe(201);
  }
}

beforeEach(async () => {
  priorDataDir = process.env.MEMWARDEN_DATA_DIR;
  priorRecallPolicy = process.env.MEMWARDEN_RECALL_POLICY;
  process.env.MEMWARDEN_RECALL_POLICY = "verified-only";

  temp = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-canon-e2e-")));
  repo = join(temp, "repo");
  firstData = join(temp, "brain-source");
  freshData = join(temp, "brain-fresh");
  mkdirSync(repo, { recursive: true });
  await execFileAsync("git", ["init", "-q", repo]);
  await execFileAsync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/canon-roundtrip.git"]);
  repo = realpathSync(repo);
  await bootStack(firstData);
});

afterEach(async () => {
  await stopStack();
  rmSync(temp, { recursive: true, force: true });
  if (priorDataDir === undefined) delete process.env.MEMWARDEN_DATA_DIR;
  else process.env.MEMWARDEN_DATA_DIR = priorDataDir;
  if (priorRecallPolicy === undefined) delete process.env.MEMWARDEN_RECALL_POLICY;
  else process.env.MEMWARDEN_RECALL_POLICY = priorRecallPolicy;
});

describe("Canon CLI/HTTP/store verified round trip", () => {
  it("pushes real Memories, safely merges, pulls into a fresh brain, and fails closed on drift", async () => {
    const sourceText = "export const ROUNDTRIP_SENTINEL = 'capture-hash';\n";
    const secretSource = "export const credentialLocation = 'vault';\n";
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/auth.ts"), sourceText, "utf8");
    writeFileSync(join(repo, "src/secret.ts"), secretSource, "utf8");

    await captureFile(
      "src/auth.ts",
      "ROUNDTRIP_SENTINEL proves Canon keeps the exact distilled architecture decision.",
      "source",
    );
    // Valid source evidence carrying credential-looking prose: it reaches a
    // real stored Memory, then the CLI push gate must keep it out of git.
    const fakeConnection = "postgres://admin:hunter2@db.internal:5432/app";
    await captureFile(
      "src/secret.ts",
      `deployment notes accidentally contained ${fakeConnection}`,
      "secret",
    );

    const distilled = await sdk!.trigger<
      Record<string, never>,
      { consolidated: number; folded: number }
    >({ function_id: "mem::consolidate-pipeline", payload: {} });
    expect(distilled).toMatchObject({ consolidated: 2, folded: 6 });

    const sourceBrain = await kv.list<Memory>(KV.memories);
    expect(sourceBrain).toHaveLength(2);
    const sourceMemory = sourceBrain.find((m) => m.files.includes("src/auth.ts"))!;
    const secretMemory = sourceBrain.find((m) => m.files.includes("src/secret.ts"))!;
    expect(sourceMemory).toBeDefined();
    expect(secretMemory.content).toContain(fakeConnection);
    expect(sourceMemory.provenance?.fileHashes?.["src/auth.ts"]).toBe(
      sha256(sourceText),
    );

    const firstPush = JSON.parse(
      (await runCli(firstData, "canon", "push", "--root", repo, "--json")).stdout,
    ) as {
      mode: string;
      promoted: number;
      preserved: number;
      total: number;
      secretBlocked: Array<{ id: string; hits: string[] }>;
    };
    expect(firstPush).toMatchObject({
      mode: "merge",
      promoted: 1,
      preserved: 0,
      total: 1,
    });
    expect(firstPush.secretBlocked).toHaveLength(1);
    expect(firstPush.secretBlocked[0]!.id).toBe(secretMemory.id);
    expect(JSON.stringify(firstPush)).not.toContain(fakeConnection);

    let canon = readCanon(repo).records;
    expect(canon).toHaveLength(1);
    const promoted = canon[0]!;
    expect(promoted).toMatchObject({
      id: sourceMemory.id,
      type: sourceMemory.type,
      projectKey: projectKey(repo),
      title: sourceMemory.title,
      content: sourceMemory.content,
      files: ["src/auth.ts"],
      fileHashes: { "src/auth.ts": sha256(sourceText) },
      capturedBy: { host: "claude-code" },
    });
    expect(JSON.stringify(promoted)).not.toContain(temp);
    expect(readFileSync(join(repo, ".memwarden/canon.jsonl"), "utf8")).not.toContain(
      fakeConnection,
    );

    // A teammate's valid record exists only in Canon, not in this local brain.
    // The second default push must preserve it rather than replacing the file
    // with the daemon's partial inventory.
    const teamText = "export const TEAM_ONLY_SENTINEL = true;\n";
    writeFileSync(join(repo, "src/team.ts"), teamText, "utf8");
    const teamRecord: CanonRecord = {
      format: 1,
      id: "mem_team_only",
      type: "fact",
      projectKey: projectKey(repo),
      title: "Team-only Canon record",
      content: "TEAM_ONLY_SENTINEL is intentionally absent from the source brain.",
      concepts: ["TEAM_ONLY_SENTINEL"],
      files: ["src/team.ts"],
      fileHashes: { "src/team.ts": sha256(teamText) },
      capturedBy: { host: "codex", agentId: "team-agent" },
      promotedAt: "2025-03-04T05:06:07.000Z",
      reanchoredBy: "reviewer",
      reanchoredAt: "2025-03-05T06:07:08.000Z",
    };
    writeCanon(repo, [...canon, teamRecord]);

    const secondPush = JSON.parse(
      (await runCli(firstData, "canon", "push", "--root", repo, "--json")).stdout,
    ) as { mode: string; promoted: number; preserved: number; total: number };
    expect(secondPush).toMatchObject({
      mode: "merge",
      promoted: 1,
      preserved: 1,
      total: 2,
    });
    canon = readCanon(repo).records;
    expect(canon.map((r) => r.id).sort()).toEqual([
      sourceMemory.id,
      teamRecord.id,
    ].sort());
    const replacePreview = JSON.parse(
      (
        await runCli(
          firstData,
          "canon",
          "push",
          "--root",
          repo,
          "--replace",
          "--dry-run",
          "--json",
        )
      ).stdout,
    ) as { mode: string; promoted: number; preserved: number; total: number; dryRun: boolean };
    expect(replacePreview).toMatchObject({
      mode: "replace",
      promoted: 1,
      preserved: 0,
      total: 1,
      dryRun: true,
    });
    // Dry-run proves the destructive mode explicitly without deleting the team
    // fixture needed for pull.
    expect(readCanon(repo).records).toHaveLength(2);

    // A genuinely fresh on-disk brain: only the committed Canon survives the
    // restart. Pull uses the dedicated HTTP import, not observe reconstruction.
    await bootStack(freshData);
    expect(await kv.list(KV.memories)).toEqual([]);
    const pull = JSON.parse(
      (
        await runCli(
          freshData,
          "canon",
          "pull",
          "--root",
          repo,
          "--yes",
          "--json",
        )
      ).stdout,
    ) as { loaded: number; refused: number };
    expect(pull).toEqual(expect.objectContaining({ loaded: 2, refused: 0 }));

    const imported = await kv.list<Memory>(KV.memories);
    expect(imported).toHaveLength(2);
    const roundTripped = imported.find((m) => m.id === sourceMemory.id)!;
    expect(roundTripped).toMatchObject({
      title: sourceMemory.title,
      content: sourceMemory.content,
      files: ["src/auth.ts"],
      projectPath: repo,
      projectKey: projectKey(repo),
      captureCwd: repo,
      provenance: {
        cwd: repo,
        files: ["src/auth.ts"],
        fileHashes: { "src/auth.ts": sha256(sourceText) },
        canon: {
          recordId: sourceMemory.id,
          projectKey: projectKey(repo),
          promotedAt: promoted.promotedAt,
          capturedBy: promoted.capturedBy,
        },
      },
    });
    expect(roundTripped.project).toBeUndefined();
    expect(imported.find((m) => m.id === teamRecord.id)?.provenance?.canon).toMatchObject({
      reanchoredBy: "reviewer",
      reanchoredAt: teamRecord.reanchoredAt,
      capturedBy: teamRecord.capturedBy,
    });

    const doctor = await runCli(freshData, "doctor", repo);
    expect(doctor.stdout).toContain("VERIFIED:        2 memories");
    expect(doctor.stdout).toContain("STALE:           0 memories");

    const why = JSON.parse(
      (
        await runCli(
          freshData,
          "why",
          sourceMemory.id,
          "--root",
          repo,
          "--json",
        )
      ).stdout,
    ) as {
      found: boolean;
      observation: { title: string; narrative: string };
      verdict: { status: string; trust: string };
      provenance: { files: string[]; fileHashes: Record<string, string> };
    };
    expect(why).toMatchObject({
      found: true,
      observation: {
        title: sourceMemory.title,
        narrative: sourceMemory.content,
      },
      verdict: { status: "verified", trust: "verified" },
      provenance: {
        files: ["src/auth.ts"],
        fileHashes: { "src/auth.ts": sha256(sourceText) },
      },
    });

    const safeRecall = await post("/search", {
      query: "ROUNDTRIP_SENTINEL",
      project: repo,
      cwd: repo,
      safe_only: true,
      format: "narrative",
      limit: 10,
    });
    expect(safeRecall.status).toBe(200);
    const recalled = (await safeRecall.json()) as {
      results: Array<{ obsId: string; title: string; narrative: string; trust: string }>;
    };
    expect(recalled.results).toContainEqual(
      expect.objectContaining({
        obsId: sourceMemory.id,
        title: sourceMemory.title,
        narrative: sourceMemory.content,
        trust: "verified",
      }),
    );

    // Pull produced real Memory rows, so pushing the fresh brain composes too.
    // The prior records (including human attestation) are retained byte-for-byte.
    const beforeRepush = readFileSync(join(repo, ".memwarden/canon.jsonl"), "utf8");
    const repush = JSON.parse(
      (await runCli(freshData, "canon", "push", "--root", repo, "--json")).stdout,
    ) as { promoted: number; preserved: number; total: number };
    expect(repush).toMatchObject({ promoted: 2, preserved: 0, total: 2 });
    expect(readFileSync(join(repo, ".memwarden/canon.jsonl"), "utf8")).toBe(
      beforeRepush,
    );

    // Drift after promotion: pull re-verifies locally and refuses this record;
    // the already-loaded Memory also becomes stale at doctor/why/recall time.
    writeFileSync(
      join(repo, "src/auth.ts"),
      "export const ROUNDTRIP_SENTINEL = 'changed-after-capture';\n",
      "utf8",
    );
    const stalePull = JSON.parse(
      (
        await runCli(
          freshData,
          "canon",
          "pull",
          "--root",
          repo,
          "--yes",
          "--json",
        )
      ).stdout,
    ) as { loaded: number; refused: number };
    expect(stalePull).toMatchObject({ loaded: 1, refused: 1 });

    const staleRecall = await post("/search", {
      query: "ROUNDTRIP_SENTINEL",
      project: repo,
      cwd: repo,
      safe_only: true,
      format: "narrative",
      limit: 10,
    });
    const staleBody = (await staleRecall.json()) as {
      results: Array<{ obsId: string }>;
      firewall: { refused: number };
    };
    expect(staleBody.results.some((r) => r.obsId === sourceMemory.id)).toBe(false);
    expect(staleBody.firewall.refused).toBeGreaterThan(0);

    const staleWhy = JSON.parse(
      (
        await runCli(
          freshData,
          "why",
          sourceMemory.id,
          "--root",
          repo,
          "--json",
        )
      ).stdout,
    ) as { verdict: { status: string; trust: string }; injectable: boolean };
    expect(staleWhy).toMatchObject({
      verdict: { status: "stale", trust: "stale" },
      injectable: false,
    });
    const staleDoctor = await runCli(freshData, "doctor", repo);
    expect(staleDoctor.stdout).toContain("VERIFIED:        1 memories");
    expect(staleDoctor.stdout).toContain("STALE:           1 memories");
  }, 60_000);
});
