//
// Local, in-process embedding provider. Runs a sentence-transformer
// (all-MiniLM-L6-v2, 384-dim) through transformers.js on the WASM/WebGPU
// backend — no Python, no CUDA, no native compilation, so it preserves
// memwarden's zero-native-dependency, self-custody promise. The model
// (~23MB ONNX) is downloaded once on first use and cached on disk.
//
// transformers.js is an OPTIONAL dependency, loaded lazily via a dynamic
// import with a variable specifier so the core typechecks and the test
// suite runs without it installed. If it is absent, embed() throws a clear
// message and the vector stream stays off (BM25 keeps working) — the
// guarded add path in search.ts soft-fails, it never breaks observe.

import type { EmbeddingProvider } from "../functions/types.js";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const MINILM_DIMS = 384;

// Known output dimensions for the models we ship as presets. Anything else
// is probed from the first embedding.
const KNOWN_DIMS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/nomic-embed-text-v1": 768,
};

// Minimal shape of the transformers.js pipeline we rely on.
type FeatureExtractor = (
  input: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private model: string;
  private extractor: FeatureExtractor | null = null;
  private loading: Promise<FeatureExtractor> | null = null;

  constructor(model: string = DEFAULT_MODEL) {
    this.model = model;
    this.name = `local:${model}`;
    this.dimensions = KNOWN_DIMS[model] ?? MINILM_DIMS;
  }

  // Lazily construct the feature-extraction pipeline. The import uses a
  // variable specifier on purpose: it keeps tsc from resolving the optional
  // package at build time and isolates the heavy load to first use.
  private async ensure(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      this.loading = (async () => {
        const specifier = "@huggingface/transformers";
        let mod: { pipeline?: unknown };
        try {
          mod = (await import(specifier)) as { pipeline?: unknown };
        } catch {
          throw new Error(
            "Local embeddings require the optional '@huggingface/transformers' package. " +
              "Install it with: npm install @huggingface/transformers",
          );
        }
        const pipeline = mod.pipeline as
          | ((task: string, model: string) => Promise<FeatureExtractor>)
          | undefined;
        if (typeof pipeline !== "function") {
          throw new Error(
            "@huggingface/transformers did not export a usable 'pipeline'",
          );
        }
        const extractor = await pipeline("feature-extraction", this.model);
        this.extractor = extractor;
        return extractor;
      })();
    }
    return this.loading;
  }

  /** Warm the model so the first observe/search doesn't pay the load. */
  async warmup(): Promise<void> {
    await this.ensure();
  }

  /**
   * Fast check: is the optional '@huggingface/transformers' package even
   * resolvable? Resolves the module (cheap) without building the pipeline or
   * downloading the model (expensive). Lets the daemon decide at boot whether
   * to advertise semantic memory at all, instead of claiming it's on and then
   * silently falling back to BM25 when the package isn't installed (it's a
   * devDependency, so npx installs won't have it).
   */
  static async isAvailable(): Promise<boolean> {
    try {
      const specifier = "@huggingface/transformers";
      const mod = (await import(specifier)) as { pipeline?: unknown };
      return typeof mod.pipeline === "function";
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.ensure();
    const out = await extractor(text, { pooling: "mean", normalize: true });
    const row = out.tolist()[0];
    if (!row) throw new Error("embedding extraction returned no rows");
    return Float32Array.from(row);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.ensure();
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    return out.tolist().map((row) => Float32Array.from(row));
  }
}
