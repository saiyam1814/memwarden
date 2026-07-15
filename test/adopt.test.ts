//
// adopt — the honesty contract for seeding a FOREIGN memory store into the
// brain. The whole reason `adopt` needs its own marker is that adopted memory
// must never be able to reach `verified`: it carried no capture-time hashes,
// so hashing its files against the current repo would forge a verdict about a
// state we never saw. These tests boot the full stack the way src/index.ts
// does and prove, over the REST wire:
//
//   1. an adopted observation whose referenced file EXISTS AND MATCHES on disk
//      still classifies `sourced_unverified` — never `verified`;
//   2. an identical NON-adopted capture of the same file DOES reach `verified`
//      (the control — proving the gate, not a broken hasher, is what caps it);
//   3. an adopted memory whose referenced file is GONE classifies `stale`;
//   4. the `adopt()` CLI walks a real CLAUDE.md store and seeds every memory,
//      each landing sourced_unverified.
//
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerWorker,
  startHttpServer,
  __resetKernelSingleton,
  type Kernel,
  type RunningHttpServer,
} from "../src/kernel/index.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { classifyProvenance } from "../src/functions/verify.js";
import { lookupFix } from "../src/functions/dejafix.js";
import { StateKV as StateKVType } from "../src/state/kv.js";
import type { CompressedObservation } from "../src/functions/types.js";

// Point secret resolution at a clean, empty data dir so the API stays open in
// tests — otherwise a developer machine with a real `~/.memwarden/secret` (from
// `memwarden up`) makes the unauthenticated wire calls below 401. Set before
// the first request so getSecret()'s one-shot file read caches "no secret".
const DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-adopt-data-")));
process.env.MEMWARDEN_DATA_DIR = DATA_DIR;
delete process.env.MEMWARDEN_SECRET;

let sdk: Kernel;
let store: StoreLibsql;
let http: RunningHttpServer;
let base: string; // .../memwarden
let origin: string; // http://127.0.0.1:PORT
let repo: string; // a real on-disk checkout the memories talk about

beforeEach(async () => {
  __resetKernelSingleton();
  getSearchIndex().clear();

  store = new StoreLibsql({ url: ":memory:" });
  sdk = registerWorker("in-process", { workerName: "memwarden-adopt" }, { store });
  const kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  registerApiTriggers(sdk);

  http = startHttpServer(sdk, { port: 0 });
  await waitForListening(http);
  const addr = http.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  expect(port).toBeGreaterThan(0);
  origin = `http://127.0.0.1:${port}`;
  base = `${origin}/memwarden`;

  // A real checkout with a file the adopted memory will reference.
  repo = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-adopt-repo-")));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "config.ts"), "export const REFRESH_TTL_MIN = 15;\n");
});

afterEach(async () => {
  await http.close().catch(() => undefined);
  await sdk.shutdown();
  __resetKernelSingleton();
  rmSync(repo, { recursive: true, force: true });
});

function waitForListening(server: RunningHttpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (server.server.listening) return resolve();
    server.server.once("listening", () => resolve());
  });
}

async function postObserve(body: unknown): Promise<Response> {
  return fetch(`${base}/observe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The synthetic compression (carrying the provenance the firewall judges) is
// written OVER the raw under the same observations key, so read it back there.
async function readProvenance(sessionId: string): Promise<CompressedObservation> {
  const compressed = await store.list<CompressedObservation>(
    KV.observations(sessionId),
  );
  expect(compressed.length).toBeGreaterThan(0);
  return compressed[compressed.length - 1]!;
}

function seedPayload(over: Record<string, unknown> = {}) {
  return {
    hookType: "user_prompt",
    sessionId: "adopt-sess",
    project: repo,
    cwd: repo,
    timestamp: new Date().toISOString(),
    agent: "adopt",
    adopted: true,
    data: {
      prompt:
        "Refresh token rotation\n\nrefresh tokens rotate every 15 minutes (REFRESH_TTL_MIN=15 in src/config.ts)",
      tool_input: [{ file_path: "src/config.ts" }],
    },
    ...over,
  };
}

describe("adopt: the sourced_unverified honesty contract", () => {
  it("an adopted memory whose file exists and matches is sourced_unverified, NOT verified", async () => {
    const res = await postObserve(seedPayload());
    expect(res.status).toBe(201);

    const obs = await readProvenance("adopt-sess");
    // The referenced file rode into provenance...
    expect(obs.provenance?.files).toContain("src/config.ts");
    // ...but was deliberately NOT hashed at capture — that is the whole gate.
    expect(obs.provenance?.fileHashes ?? {}).toEqual({});

    // And so the firewall caps it at sourced_unverified even though the file
    // is present and unchanged on disk.
    const verdict = classifyProvenance(obs.provenance, repo);
    expect(verdict.status).toBe("sourced_unverified");
  });

  it("the SAME memory captured normally (not adopted) reaches verified — proving the gate", async () => {
    const res = await postObserve(seedPayload({ adopted: false, sessionId: "normal-sess" }));
    expect(res.status).toBe(201);

    const obs = await readProvenance("normal-sess");
    // Normal capture hashed the file...
    expect(obs.provenance?.fileHashes?.["src/config.ts"]).toBeTypeOf("string");
    // ...so with the file unchanged on disk it verifies.
    const verdict = classifyProvenance(obs.provenance, repo);
    expect(verdict.status).toBe("verified");
  });

  // The side door. A fix-shaped memory ("TypeError ... fixed in src/config.ts")
  // is extremely common in a real CLAUDE.md pile, and observe.ts opportunistically
  // records it as a Déjà Fix reusing the SAME provenance. If that path re-hashes
  // the files, an adopted memory reappears to the next agent as a "verified
  // current" fix — the exact forgery the adopted marker exists to prevent, and
  // the two stores would then disagree about one memory.
  it("an adopted fix-shaped memory never surfaces as a verified Déjà Fix", async () => {
    const errorText =
      "TypeError: user is not a function. The root cause was a missing guard; fixed in src/config.ts.";
    const res = await postObserve(
      seedPayload({
        sessionId: "adopt-fix-sess",
        data: {
          prompt: errorText,
          tool_input: [{ file_path: "src/config.ts" }],
        },
      }),
    );
    expect(res.status).toBe(201);

    const fixes = await lookupFix(new StateKVType(sdk), errorText, repo);
    // It may or may not be recorded as a fix — but if it is, it must never
    // claim to be content-verified, because it was never content-anchored.
    for (const f of fixes) {
      expect(f.status).not.toBe("verified");
      expect(f.badge).not.toBe("verified current");
      expect(f.provenance?.fileHashes ?? {}).toEqual({});
    }
  });

  it("an adopted memory whose referenced file is gone classifies stale", async () => {
    const res = await postObserve(
      seedPayload({
        sessionId: "gone-sess",
        data: {
          prompt: "A note about a deleted module",
          tool_input: [{ file_path: "src/deleted.ts" }],
        },
      }),
    );
    expect(res.status).toBe(201);

    const obs = await readProvenance("gone-sess");
    const verdict = classifyProvenance(obs.provenance, repo);
    expect(verdict.status).toBe("stale");
  });
});

describe("adopt: every memory in the store actually lands", () => {
  // A real CLAUDE.md pile is mostly unanchored prose. If dedup keys on the
  // file list alone, every fileless memory collides and adopt reports
  // "1 adopted · 46 already present" — silent data loss reported as success.
  it("three DIFFERENT fileless memories all persist (no dedup collapse)", async () => {
    const prompts = [
      "Always use pnpm, never npm, in this repo.",
      "Deploy runs on Tuesdays after the staging soak.",
      "The staging DB password rotates monthly.",
    ];
    for (const [i, prompt] of prompts.entries()) {
      const res = await postObserve(
        seedPayload({
          sessionId: "adopt-many-sess",
          timestamp: new Date(Date.now() + i).toISOString(),
          data: { prompt, tool_input: [] },
        }),
      );
      expect(res.status).toBe(201);
    }
    const stored = await store.list<CompressedObservation>(
      KV.observations("adopt-many-sess"),
    );
    expect(stored).toHaveLength(prompts.length);
  });

  it("two different memories citing the SAME file both persist", async () => {
    const prompts = [
      "Auth: refresh tokens rotate every 15 minutes, see src/config.ts.",
      "The TTL in src/config.ts must never exceed 60 for compliance.",
    ];
    for (const [i, prompt] of prompts.entries()) {
      const res = await postObserve(
        seedPayload({
          sessionId: "adopt-samefile-sess",
          timestamp: new Date(Date.now() + i).toISOString(),
          data: { prompt, tool_input: [{ file_path: "src/config.ts" }] },
        }),
      );
      expect(res.status).toBe(201);
    }
    const stored = await store.list<CompressedObservation>(
      KV.observations("adopt-samefile-sess"),
    );
    expect(stored).toHaveLength(prompts.length);
  });
});

describe("adopt(): CLI seeds a foreign CLAUDE.md store into the brain", () => {
  it("walks the store and every memory lands sourced_unverified", async () => {
    // Point the CLI at our in-test daemon; daemonUrl()/getSecret() read env at
    // call time, so ensureDaemon finds our server alive and never spawns.
    const prevUrl = process.env.MEMWARDEN_URL;
    process.env.MEMWARDEN_URL = origin;

    const storeDir = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-adopt-store-")));
    const storeFile = join(storeDir, "CLAUDE.md");
    writeFileSync(
      storeFile,
      [
        "# Project memory",
        "",
        "- Auth: refresh tokens rotate every 15 minutes, see src/config.ts.",
        "- Build: run `npm run build` before packing.",
        // Two MORE unanchored bullets: a real CLAUDE.md is mostly fileless
        // prose, and these share an (empty) file list with the one above —
        // the exact shape a file-keyed dedup would collapse into one memory.
        "- Always use pnpm, never npm, in this repo.",
        "- Deploy runs on Tuesdays after the staging soak.",
        "",
      ].join("\n"),
    );

    try {
      const { adopt, adoptSessionId } = await import("../src/cli/adopt.js");
      // Flags BEFORE the positional store: --root's value must not be mistaken
      // for the store path.
      await adopt(["--root", repo, "--json", storeFile]);

      // Everything the CLI wrote is in the store under its stable session id.
      const sessionId = adoptSessionId("markdown", storeFile);
      const compressed = await store.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      // EVERY memory in the store must land — asserting only "> 0" is what let
      // a dedup collapse (whole store -> one memory) hide.
      const { memories } = await import("../src/functions/audit.js").then((m) =>
        m.loadStore(storeFile),
      );
      expect(compressed).toHaveLength(memories.length);
      expect(memories.length).toBeGreaterThan(1);
      for (const obs of compressed) {
        expect(obs.provenance?.fileHashes ?? {}).toEqual({});
        const verdict = classifyProvenance(obs.provenance, repo);
        expect(["sourced_unverified", "stale", "unsourced"]).toContain(verdict.status);
        expect(verdict.status).not.toBe("verified");
      }
    } finally {
      if (prevUrl === undefined) delete process.env.MEMWARDEN_URL;
      else process.env.MEMWARDEN_URL = prevUrl;
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
