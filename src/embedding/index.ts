//
// Embedding provider selection. memwarden's vector stream (and therefore
// the TurboQuant-compressed semantic memory that distinguishes it) only
// lights up when a provider is configured here.
//
//   MEMWARDEN_EMBEDDING_PROVIDER = local (default) | none
//   MEMWARDEN_EMBEDDING_MODEL    = Xenova/all-MiniLM-L6-v2 (default)
//
// "local" runs entirely on-device (see local-embedding.ts). "none" keeps
// memwarden in BM25-only mode. Cloud providers (openai, voyage) can be
// added here later behind the same interface without touching callers.

import type { EmbeddingProvider } from "../functions/types.js";
import { LocalEmbeddingProvider } from "./local-embedding.js";

export { LocalEmbeddingProvider } from "./local-embedding.js";

export function getEmbeddingProviderName(): "local" | "none" {
  const raw = (process.env.MEMWARDEN_EMBEDDING_PROVIDER ?? "local")
    .trim()
    .toLowerCase();
  return raw === "none" ? "none" : "local";
}

export function getEmbeddingModel(): string {
  const raw = process.env.MEMWARDEN_EMBEDDING_MODEL?.trim();
  return raw && raw.length > 0 ? raw : "Xenova/all-MiniLM-L6-v2";
}

/**
 * Build the configured embedding provider, or null for BM25-only mode.
 * Construction is cheap (no model load); the model loads lazily on first
 * embed, or eagerly via warmup() at boot.
 */
export function createEmbeddingProvider(): EmbeddingProvider | null {
  if (getEmbeddingProviderName() === "none") return null;
  return new LocalEmbeddingProvider(getEmbeddingModel());
}
