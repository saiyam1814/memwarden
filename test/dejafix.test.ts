//
// Déjà Fix end-to-end: the cross-agent "don't repeat a fixed mistake" engine.
//
// Proves, through the REAL kernel + a REAL temp repo + REAL KV (no mocks):
//   (a) signature extraction is stable across cosmetic variations of the same
//       error (paths, line/col, timestamps, ports, durations, casing);
//   (b) record a fix referencing a real file, then lookup the same error
//       returns it badged "verified current";
//   (c) CHANGE or DELETE the referenced file -> lookup no longer returns it
//       (the firewall: a stale fix is suppressed);
//   (d) a different error signature returns nothing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerWorker,
  __resetKernelSingleton,
  type Kernel,
} from "../src/kernel/index.js";
import { StoreLibsql } from "../src/state/store-libsql.js";
import { StateKV } from "../src/state/kv.js";
import {
  registerCoreFunctions,
  getSearchIndex,
} from "../src/functions/index.js";
import { errorSignature } from "../src/functions/dejafix.js";
import type { VerifiedFix } from "../src/functions/dejafix.js";

let sdk: Kernel;
const dirs: string[] = [];

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-dejafix" }, {
    store: new StoreLibsql({ url: ":memory:" }),
  });
  registerCoreFunctions(sdk, new StateKV(sdk));
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  __resetKernelSingleton();
});

function repo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-dejafix-")));
  dirs.push(d);
  return d;
}

async function record(input: {
  errorText: string;
  fix: string;
  rootCause?: string;
  files?: string[];
  cwd: string;
  tool?: string;
  sessionId?: string;
}): Promise<{ recorded: boolean; signature?: string }> {
  return sdk.trigger({
    function_id: "mem::dejafix_record",
    payload: input,
  });
}

async function lookup(
  errorText: string,
  cwd: string,
): Promise<{ signature: string | null; fixes: VerifiedFix[] }> {
  return sdk.trigger({
    function_id: "mem::dejafix_lookup",
    payload: { errorText, cwd },
  });
}

describe("errorSignature", () => {
  it("is stable across cosmetic variations of the same Node error", () => {
    const a = errorSignature(
      "TypeError: cannot read properties of undefined (reading 'id')\n" +
        "    at handle (/Users/alice/proj/src/server.ts:42:13)\n" +
        "    at /Users/alice/proj/node_modules/x/index.js:1:1",
    );
    const b = errorSignature(
      "TypeError: cannot read properties of undefined (reading 'id')\n" +
        "    at handle (/home/bob/work/checkout/src/server.ts:99:7)\n" +
        "    at /home/bob/work/checkout/node_modules/x/index.js:5:2",
    );
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("matches a bare message against the same message with an inline location", () => {
    // One agent logs the bare message; another logs it with an inline frame on
    // the same line. Both must produce the same signature so the fix is found.
    const bare = errorSignature(
      "TypeError: cannot read property bearer of undefined",
    );
    const inline = errorSignature(
      "TypeError: cannot read property bearer of undefined at src/auth.ts:9:14",
    );
    const inlineParen = errorSignature(
      "TypeError: cannot read property bearer of undefined at Object.<anonymous> (src/auth.ts:9:14)",
    );
    expect(bare).not.toBeNull();
    expect(inline).toBe(bare);
    expect(inlineParen).toBe(bare);
    // But a non-frame "at" (no :line) is part of the message, not stripped.
    expect(errorSignature("Error: connection refused at startup")).not.toBe(
      errorSignature("Error: connection refused"),
    );
  });

  it("normalizes timestamps, ports, durations, hex and UUIDs", () => {
    const a = errorSignature(
      "Error: connect ECONNREFUSED 127.0.0.1:5432 at 2026-06-10T12:00:00.000Z after 1200ms",
    );
    const b = errorSignature(
      "Error: connect ECONNREFUSED 127.0.0.1:6543 at 2026-01-02T03:04:05.999Z after 30ms",
    );
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("extracts a stable TypeScript compiler error signature", () => {
    const a = errorSignature(
      "src/foo.ts(12,5): error TS2304: Cannot find name 'Widget'.",
    );
    const b = errorSignature(
      "/abs/path/src/foo.ts:99:1 - error TS2304: Cannot find name 'Widget'.",
    );
    expect(a).not.toBeNull();
    expect(a).toContain("ts2304");
    expect(a).toBe(b);
  });

  it("extracts a stable failing-test signature (vitest + jest shapes)", () => {
    const vitest = errorSignature(
      " FAIL  test/auth.test.ts > auth > rejects an expired token",
    );
    const jest = errorSignature("  ✕ auth › rejects an expired token (15 ms)");
    expect(vitest).not.toBeNull();
    expect(vitest).toContain("rejects an expired token");
    expect(jest).not.toBeNull();
    expect(jest).toContain("rejects an expired token");
  });

  it("returns null when there is no recognizable error", () => {
    expect(errorSignature("")).toBeNull();
    expect(errorSignature("everything is fine, build succeeded")).toBeNull();
    expect(errorSignature("   ")).toBeNull();
  });
});

describe("Déjà Fix record + Verified Recall lookup", () => {
  it("records a fix referencing a real file, then recalls it verified current", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "db.ts"),
      "export const pool = { max: 10 };\n",
    );

    const errA =
      "Error: connect ECONNREFUSED 127.0.0.1:5432 at 2026-06-10T12:00:00.000Z after 1200ms";
    const rec = await record({
      errorText: errA,
      fix: "Bumped the pool max and added a connect retry in src/db.ts",
      rootCause: "DB pool exhausted under load",
      files: ["src/db.ts"],
      cwd: root,
      tool: "codex",
      sessionId: "s1",
    });
    expect(rec.recorded).toBe(true);

    // A cosmetically different spelling of the same error must hit it.
    const errVariant =
      "Error: connect ECONNREFUSED 127.0.0.1:6543 at 2026-02-02T01:02:03.004Z after 42ms";
    const res = await lookup(errVariant, root);
    expect(res.signature).toBe(rec.signature);
    expect(res.fixes.length).toBe(1);
    const fix = res.fixes[0]!;
    expect(fix.badge).toBe("verified current");
    expect(fix.status).toBe("verified");
    expect(fix.fix).toContain("pool max");
    expect(fix.rootCause).toContain("pool exhausted");
    expect(fix.tool).toBe("codex");
  });

  it("suppresses the fix once its referenced file content changes (drift firewall)", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "db.ts"), "export const pool = { max: 10 };\n");

    const err = "Error: connect ECONNREFUSED 127.0.0.1:5432";
    await record({
      errorText: err,
      fix: "Tuned the pool in src/db.ts",
      files: ["src/db.ts"],
      cwd: root,
    });
    expect((await lookup(err, root)).fixes.length).toBe(1);

    // The file the fix referenced is rewritten -> the fix is now stale.
    writeFileSync(join(root, "src", "db.ts"), "export const pool = { max: 99 };\n");
    expect((await lookup(err, root)).fixes.length).toBe(0);
  });

  it("suppresses the fix once its referenced file is deleted", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "db.ts"), "export const pool = { max: 10 };\n");

    const err = "Error: connect ECONNREFUSED 127.0.0.1:5432";
    await record({
      errorText: err,
      fix: "Tuned the pool in src/db.ts",
      files: ["src/db.ts"],
      cwd: root,
    });
    expect((await lookup(err, root)).fixes.length).toBe(1);

    rmSync(join(root, "src", "db.ts"));
    expect((await lookup(err, root)).fixes.length).toBe(0);
  });

  it("returns nothing for a different error signature", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "db.ts"), "export const pool = { max: 10 };\n");
    await record({
      errorText: "Error: connect ECONNREFUSED 127.0.0.1:5432",
      fix: "Tuned the pool in src/db.ts",
      files: ["src/db.ts"],
      cwd: root,
    });

    const res = await lookup(
      "TypeError: cannot read properties of undefined (reading 'x')",
      root,
    );
    expect(res.fixes.length).toBe(0);
  });

  it("does not surface a fix learned in a different project", async () => {
    const rootA = repo();
    const rootB = repo();
    mkdirSync(join(rootA, "src"));
    writeFileSync(join(rootA, "src", "db.ts"), "export const pool = { max: 10 };\n");
    // rootB has the same relative file so it would verify there too — the
    // project firewall, not verification, must keep them apart.
    mkdirSync(join(rootB, "src"));
    writeFileSync(join(rootB, "src", "db.ts"), "export const pool = { max: 10 };\n");

    const err = "Error: connect ECONNREFUSED 127.0.0.1:5432";
    await record({ errorText: err, fix: "fix in A", files: ["src/db.ts"], cwd: rootA });

    expect((await lookup(err, rootA)).fixes.length).toBe(1);
    expect((await lookup(err, rootB)).fixes.length).toBe(0);
  });

  it("returns sourced, unverified when the fix referenced no files", async () => {
    const root = repo();
    const err = "Error: flaky network blip during deploy";
    const rec = await record({
      errorText: err,
      fix: "Re-ran the deploy; transient",
      cwd: root,
    });
    expect(rec.recorded).toBe(true);
    const res = await lookup(err, root);
    expect(res.fixes.length).toBe(1);
    expect(res.fixes[0]!.badge).toBe("sourced, unverified");
    expect(res.fixes[0]!.status).toBe("sourced_unverified");
  });
});

describe("opportunistic capture through mem::observe", () => {
  it("captures a fix when an observation contains both an error and resolution language", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "auth.ts"), "// token verify\n");

    // An observation whose output reads like a recorded fix.
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "s1",
        project: root,
        cwd: root,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "Edit",
          tool_input: { file_path: "src/auth.ts" },
          tool_output:
            "TypeError: cannot read properties of undefined (reading 'exp'). " +
            "Fixed by null-checking the decoded token in src/auth.ts. Root cause: missing guard.",
        },
      },
    });

    const res = await lookup(
      "TypeError: cannot read properties of undefined (reading 'exp')",
      root,
    );
    expect(res.fixes.length).toBeGreaterThan(0);
    expect(res.fixes[0]!.badge).toBe("verified current");
  });

  it("does NOT capture a fix for a plain non-error observation", async () => {
    const root = repo();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "ok.ts"), "export const ok = true;\n");

    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "post_tool_use",
        sessionId: "s1",
        project: root,
        cwd: root,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "Edit",
          tool_input: { file_path: "src/ok.ts" },
          tool_output: "wrote a small helper, all good",
        },
      },
    });

    // Nothing error-shaped was observed, so a lookup for an unrelated error
    // returns nothing (no stray capture).
    const res = await lookup(
      "TypeError: cannot read properties of undefined (reading 'exp')",
      root,
    );
    expect(res.fixes.length).toBe(0);
  });
});
