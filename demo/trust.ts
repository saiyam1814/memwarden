import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetKernelSingleton,
  registerWorker,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreMemory } from "../src/state/store-memory.js";
import { StateKV } from "../src/state/kv.js";
import { getSearchIndex, registerCoreFunctions } from "../src/functions/index.js";
import type { DoctorReport } from "../src/functions/doctor.js";

interface SearchOut {
  results: Array<{
    observation?: { narrative?: string };
    narrative?: string;
  }>;
}

process.env.MEMWARDEN_LOG_LEVEL = "error";

const root = mkdtempSync(join(tmpdir(), "memwarden-trust-demo-"));

function boot(): Kernel {
  __resetKernelSingleton();
  getSearchIndex().clear();
  const sdk = registerWorker(
    "in-process",
    { workerName: "memwarden-trust-demo" },
    { store: new StoreMemory() },
  );
  registerCoreFunctions(sdk, new StateKV(sdk));
  return sdk;
}

async function observe(
  sdk: Kernel,
  sessionId: string,
  file: string,
  output: string,
  timestamp: string,
): Promise<void> {
  await sdk.trigger({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId,
      project: root,
      cwd: root,
      timestamp,
      data: {
        tool_name: "Edit",
        tool_input: { file_path: file },
        tool_output: output,
      },
    },
  });
}

async function search(
  sdk: Kernel,
  query: string,
  safeOnly: boolean,
): Promise<SearchOut> {
  return await sdk.trigger({
    function_id: "mem::search",
    payload: {
      query,
      project: root,
      cwd: root,
      limit: 10,
      safe_only: safeOnly,
    },
  }) as SearchOut;
}

function pass(label: string, value: string | number): void {
  console.log(`  OK  ${label}: ${value}`);
}

try {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.ts"), "export const auth = 'bearer';\n");
  writeFileSync(join(root, "src", "runtime.ts"), "export const runtime = 'stable';\n");

  const sdk = boot();

  console.log("\nmemwarden trust demo\n");
  console.log(`repo: ${root}\n`);

  console.log("1. Stale refusal");
  await observe(
    sdk,
    "claude-old",
    "src/auth.ts",
    "auth uses bearer tokens",
    "2026-01-01T00:00:00.000Z",
  );
  const safeBefore = await search(sdk, "auth bearer tokens", true);
  pass("safe recall before file change", safeBefore.results.length);

  writeFileSync(join(root, "src", "auth.ts"), "export const auth = 'session-cookie';\n");
  const safeAfter = await search(sdk, "auth bearer tokens", true);
  const plainAfter = await search(sdk, "auth bearer tokens", false);
  pass("safe recall after file change", safeAfter.results.length);
  pass("plain search after file change", plainAfter.results.length);

  console.log("\n2. Contradiction audit");
  await observe(
    sdk,
    "codex-old",
    "src/runtime.ts",
    "runtime uses node 22",
    "2026-01-02T00:00:00.000Z",
  );
  await observe(
    sdk,
    "codex-new",
    "src/runtime.ts",
    "runtime uses bun runtime",
    "2026-01-03T00:00:00.000Z",
  );
  // Recall does NOT silently drop conflicting memories — losing a true fact is
  // worse than surfacing both. The firewall drops only STALE memory. Conflicts
  // are surfaced as an advisory by `doctor`, never quietly removed from recall.
  const safeRuntime = await search(sdk, "runtime uses", true);
  pass("both runtime claims kept in safe recall", safeRuntime.results.length);
  const report = await sdk.trigger({
    function_id: "mem::doctor",
    payload: { root },
  }) as DoctorReport;

  pass("verified memories", report.verified);
  pass("stale memories", report.stale.length);
  pass("possible contradictions (advisory)", report.conflicts.length);
  for (const conflict of report.conflicts) {
    console.log(`  -> ${conflict.olderClaim}`);
    console.log(`  -> ${conflict.newerClaim}`);
    console.log(`     ${conflict.reason}`);
  }

  if (
    safeBefore.results.length < 1 ||
    safeAfter.results.length !== 0 ||
    plainAfter.results.length < 1 ||
    safeRuntime.results.length < 2 ||
    report.conflicts.length < 1
  ) {
    throw new Error("trust demo did not prove stale refusal + conflict audit");
  }

  console.log("\nDemo passed: stale memory was refused, explicit search still found it, safe recall kept both contradicting claims (no silent loss), and doctor flagged the contradiction as an advisory.\n");
} finally {
  rmSync(root, { recursive: true, force: true });
  __resetKernelSingleton();
}
