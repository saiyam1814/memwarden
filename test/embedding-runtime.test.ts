//
// Semantic runtime resolution: `memwarden up` installs transformers.js under
// <dataDir>/runtime and the embedding loader must find it there without the
// bare specifier resolving. Uses a fake package fixture — the mechanism under
// test is resolution + entry import, not transformers itself.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveTransformersEntry,
  semanticRuntimeRoot,
} from "../src/embedding/runtime.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mw-runtime-"));
  const pkgDir = join(root, "node_modules", "@huggingface", "transformers");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@huggingface/transformers",
      version: "3.8.1",
      type: "module",
      exports: {
        node: { import: { default: "./dist/fake.node.mjs" } },
        default: { default: "./dist/fake.web.js" },
      },
    }),
  );
  writeFileSync(
    join(pkgDir, "dist", "fake.node.mjs"),
    "export function pipeline() { return async () => ({ tolist: () => [[0.1]] }); }\n",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("semantic runtime resolution", () => {
  it("resolves the node ESM entry from a runtime root", () => {
    const entry = resolveTransformersEntry(root);
    expect(entry).toBeTruthy();
    expect(entry).toContain("fake.node.mjs");
  });

  it("returns null when the package is absent", () => {
    expect(resolveTransformersEntry(join(root, "nope"))).toBeNull();
  });

  it("the resolved entry imports and exposes pipeline()", async () => {
    const entry = resolveTransformersEntry(root)!;
    const mod = (await import(pathToFileURL(entry).href)) as {
      pipeline?: unknown;
    };
    expect(typeof mod.pipeline).toBe("function");
  });

  it("semanticRuntimeRoot honors an explicit dataDir over env", () => {
    expect(semanticRuntimeRoot("/x/data")).toBe(join("/x/data", "runtime"));
  });
});
