//
// The firewall evaluation corpus. Deterministic, synthetic-but-realistic:
// 200 memories across 5 projects with controlled staleness events, measuring
// the claims the launch makes. Run: npm run eval  (CI runs it too).
//
// Gates (exit 1 on any failure):
//   stale-refusal      100% of known-stale memories blocked under safe_only
//   fresh-retention    100% of verified-current memories NOT wrongly blocked
//   isolation          0 out-of-project results under scoping
//   label-accuracy     recall labels match ground-truth provenance classes
//
// In-process kernel (same wiring as the test suite) so the numbers are the
// engine's, with no network noise.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { StateKV } from "../src/state/kv.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";

const PROJECTS = 5;
const PER_PROJECT = 40; // 200 total
const STALE_EVERY = 4; // every 4th memory's file gets drifted later

interface Fact {
  project: string;
  file: string;
  obsText: string;
  key: string; // unique needle for detection
  willGoStale: boolean;
}

const dirs: string[] = [];
function projDir(i: number): string {
  const d = mkdtempSync(join(tmpdir(), `mw-eval-p${i}-`));
  dirs.push(d);
  return d;
}

async function main(): Promise<void> {
  __resetKernelSingleton();
  getSearchIndex().clear();
  const sdk: Kernel = registerWorker(
    "in-process",
    { workerName: "memwarden-eval" },
    { store: new StoreLibsql({ url: ":memory:" }) },
  );
  registerCoreFunctions(sdk, new StateKV(sdk));

  // --- build the corpus --------------------------------------------------
  const facts: Fact[] = [];
  const projects: string[] = [];
  for (let p = 0; p < PROJECTS; p++) {
    const root = projDir(p);
    projects.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    for (let i = 0; i < PER_PROJECT; i++) {
      const file = `src/mod${i}.ts`;
      const key = `FACT_P${p}_N${i}`;
      writeFileSync(join(root, file), `export const V_${i} = ${i}; // ${key}\n`);
      facts.push({
        project: root,
        file,
        obsText: `decided: module ${i} uses constant V_${i}=${i} (${key}) in ${file}`,
        key,
        willGoStale: i % STALE_EVERY === 0,
      });
    }
  }
  for (const [n, f] of facts.entries()) {
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: `s-${f.project.slice(-6)}`,
        project: f.project,
        cwd: f.project,
        timestamp: new Date(Date.now() - (facts.length - n) * 1000).toISOString(),
        data: {
          tool_name: "Edit",
          tool_input: { file_path: join(f.project, f.file) },
          tool_output: f.obsText,
        },
      },
    });
  }

  // --- staleness events: drift every marked file -------------------------
  for (const f of facts) {
    if (f.willGoStale) {
      writeFileSync(join(f.project, f.file), `// rewritten — the old fact is gone\n`);
    }
  }

  // --- measure ------------------------------------------------------------
  let staleBlocked = 0;
  let staleTotal = 0;
  let freshKept = 0;
  let freshTotal = 0;
  let leaks = 0;
  let labelChecked = 0;
  let labelCorrect = 0;

  for (const f of facts) {
    const res = (await sdk.trigger({
      function_id: "mem::search",
      payload: {
        query: f.key,
        cwd: f.project,
        project: f.project,
        format: "narrative",
        limit: 5,
        safe_only: true,
      },
    })) as {
      results: Array<{ narrative?: string; title?: string; trust?: string }>;
    };
    const hit = res.results.find((r) => JSON.stringify(r).includes(f.key));
    const myProject = /FACT_(P\d+)_/.exec(f.key)![1]!;
    if (f.willGoStale) {
      staleTotal++;
      if (!hit) staleBlocked++;
    } else {
      freshTotal++;
      if (hit) {
        freshKept++;
        labelChecked++;
        if (hit.trust === "verified") labelCorrect++;
      }
    }
    // Isolation: no result may come from another project's corpus.
    for (const r of res.results) {
      const m = /FACT_(P\d+)_/.exec(JSON.stringify(r));
      if (m && m[1] !== myProject) leaks++;
    }
  }

  const pct = (a: number, b: number) => (b === 0 ? "n/a" : ((a / b) * 100).toFixed(1) + "%");
  const rows: Array<[string, string, string, boolean]> = [
    ["stale-refusal", `${staleBlocked}/${staleTotal}`, pct(staleBlocked, staleTotal), staleBlocked === staleTotal],
    ["fresh-retention", `${freshKept}/${freshTotal}`, pct(freshKept, freshTotal), freshKept === freshTotal],
    ["isolation (leaks)", `${leaks}`, leaks === 0 ? "0 leaks" : `${leaks} LEAKS`, leaks === 0],
    ["label-accuracy", `${labelCorrect}/${labelChecked}`, pct(labelCorrect, labelChecked), labelCorrect === labelChecked],
  ];

  console.log(`\n  memwarden firewall eval — ${facts.length} memories, ${PROJECTS} projects, ${staleTotal} staleness events\n`);
  console.log(`  ${"metric".padEnd(20)} ${"raw".padEnd(10)} ${"score".padEnd(10)} gate`);
  let failed = false;
  for (const [name, raw, score, ok] of rows) {
    if (!ok) failed = true;
    console.log(`  ${name.padEnd(20)} ${raw.padEnd(10)} ${score.padEnd(10)} ${ok ? "PASS" : "FAIL"}`);
  }
  console.log("");

  await sdk.shutdown();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("eval failed:", err);
  process.exit(1);
});
