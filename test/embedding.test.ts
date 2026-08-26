//
// Embedding provider selection. Construction must be cheap and model-free
// (the heavy load is lazy), so these tests never touch the network — they
// assert the factory wiring and the TurboQuant-follows-embeddings default,
// not actual inference.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddingProvider,
  getEmbeddingProviderName,
  getEmbeddingModel,
  LocalEmbeddingProvider,
} from "../src/embedding/index.js";
import { isQuantizedVectorEnabled } from "../src/functions/config.js";

const embeddingMocks = vi.hoisted(() => ({
  outputDispose: vi.fn(),
  pipelineDispose: vi.fn(async () => undefined),
}));

vi.mock("../src/embedding/runtime.js", () => ({
  importTransformers: async () => ({
    pipeline: async () =>
      Object.assign(
        async (input: string | string[]) => ({
          tolist: () =>
            (Array.isArray(input) ? input : [input]).map(() => [0.5, -0.5]),
          dispose: embeddingMocks.outputDispose,
        }),
        { dispose: embeddingMocks.pipelineDispose },
      ),
  }),
}));

afterEach(() => {
  delete process.env.MEMWARDEN_EMBEDDING_PROVIDER;
  delete process.env.MEMWARDEN_EMBEDDING_MODEL;
  delete process.env.MEMWARDEN_QUANT_VECTOR;
  vi.clearAllMocks();
});

describe("embedding provider factory", () => {
  it("defaults to a local MiniLM provider (384d), no model load on construct", () => {
    const p = createEmbeddingProvider();
    expect(p).toBeInstanceOf(LocalEmbeddingProvider);
    expect(p!.name).toBe("local:Xenova/all-MiniLM-L6-v2");
    expect(p!.dimensions).toBe(384);
  });

  it("returns null in BM25-only mode", () => {
    process.env.MEMWARDEN_EMBEDDING_PROVIDER = "none";
    expect(getEmbeddingProviderName()).toBe("none");
    expect(createEmbeddingProvider()).toBeNull();
  });

  it("honors a custom model name", () => {
    process.env.MEMWARDEN_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
    expect(getEmbeddingModel()).toBe("Xenova/bge-small-en-v1.5");
    const p = createEmbeddingProvider();
    expect(p!.dimensions).toBe(384);
    expect(p!.name).toContain("bge-small");
  });

  it("disposes inference outputs and the native model session before shutdown", async () => {
    const p = new LocalEmbeddingProvider();
    await p.embed("one");
    await p.embedBatch(["two", "three"]);
    expect(embeddingMocks.outputDispose).toHaveBeenCalledTimes(2);

    await p.dispose();
    expect(embeddingMocks.pipelineDispose).toHaveBeenCalledTimes(1);
    await expect(p.embed("after shutdown")).rejects.toThrow("shutting down");
  });
});

describe("TurboQuant follows the embedding provider", () => {
  it("is on by default when embeddings are active", () => {
    expect(isQuantizedVectorEnabled()).toBe(true); // provider defaults to local
  });

  it("is off when embeddings are disabled", () => {
    process.env.MEMWARDEN_EMBEDDING_PROVIDER = "none";
    expect(isQuantizedVectorEnabled()).toBe(false);
  });

  it("explicit MEMWARDEN_QUANT_VECTOR overrides either way", () => {
    process.env.MEMWARDEN_EMBEDDING_PROVIDER = "none";
    process.env.MEMWARDEN_QUANT_VECTOR = "true";
    expect(isQuantizedVectorEnabled()).toBe(true);
    process.env.MEMWARDEN_EMBEDDING_PROVIDER = "local";
    process.env.MEMWARDEN_QUANT_VECTOR = "false";
    expect(isQuantizedVectorEnabled()).toBe(false);
  });
});
