//
// Path-canonical scoping: the unified memory layer must recall the same
// project no matter how the directory is spelled. Captures under a symlinked
// path; recalls under the resolved real path (and the reverse) through the
// full observe -> search stack. A silent scope miss here would mean "memory
// that doesn't work", so this guards the fundamental.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
import { registerCoreFunctions, getSearchIndex } from "../src/functions/index.js";
import { canonicalizePath } from "../src/functions/paths.js";

let sdk: Kernel;
const dirs: string[] = [];

beforeEach(() => {
  __resetKernelSingleton();
  getSearchIndex().clear();
  sdk = registerWorker("in-process", { workerName: "memwarden-paths" }, {
    store: new StoreLibsql({ url: ":memory:" }),
  });
  registerCoreFunctions(sdk, new StateKV(sdk));
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  __resetKernelSingleton();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "memwarden-paths-"));
  dirs.push(d);
  return d;
}

async function capture(sessionId: string, cwd: string, output: string) {
  return sdk.trigger({
    function_id: "mem::observe",
    payload: {
      hookType: "post_tool_use",
      sessionId,
      project: cwd,
      cwd,
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "Edit",
        tool_input: { file_path: "auth.ts" },
        tool_output: output,
      },
    },
  });
}

async function recall(cwd: string): Promise<number> {
  const res = (await sdk.trigger({
    function_id: "mem::search",
    payload: { query: "rotation", cwd, project: cwd, limit: 10 },
  })) as { results: unknown[] };
  return res.results.length;
}

describe("canonicalizePath", () => {
  it("passes non-absolute labels through unchanged", () => {
    expect(canonicalizePath("mcp")).toBe("mcp");
    expect(canonicalizePath("")).toBe("");
  });
  it("strips a trailing slash from a non-existent absolute path", () => {
    expect(canonicalizePath("/work/alpha/")).toBe("/work/alpha");
    expect(canonicalizePath("/work/alpha")).toBe("/work/alpha");
  });
  it("resolves a symlink to its real target", () => {
    const real = realpathSync(tmp());
    const parent = tmp();
    const link = join(parent, "link");
    symlinkSync(real, link);
    expect(canonicalizePath(link)).toBe(real);
  });
});

describe("recall is scope-stable across path spellings", () => {
  it("captures under a symlink, recalls under the real path", async () => {
    const real = realpathSync(tmp());
    const link = join(tmp(), "link");
    symlinkSync(real, link);

    await capture("s1", link, "alpha auth secret rotation policy");
    // Exact-string scoping would miss here (link !== real); canonical does not.
    expect(await recall(real)).toBeGreaterThan(0);
  });

  it("captures under the real path, recalls under a symlink", async () => {
    const real = realpathSync(tmp());
    const link = join(tmp(), "link");
    symlinkSync(real, link);

    await capture("s2", real, "alpha auth secret rotation policy");
    expect(await recall(link)).toBeGreaterThan(0);
  });

  it("still isolates a genuinely different project", async () => {
    const a = realpathSync(tmp());
    const b = realpathSync(tmp());
    await capture("s3", a, "alpha auth secret rotation policy");
    expect(await recall(b)).toBe(0); // no cross-project leak
  });
});
