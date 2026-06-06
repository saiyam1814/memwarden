//
// Coerces a Memory record into the CompressedObservation shape the search
// index + enrichment paths consume. Ported verbatim from the original
// src/state/memory-utils.ts. The synthetic sessionId ("memory" or
// memory.sessionIds[0]) is what enrich-side fallbacks key off when looking
// up the source record in KV.memories.

import type { CompressedObservation, Memory } from "./types.js";

export function memoryToObservation(memory: Memory): CompressedObservation {
  return {
    id: memory.id,
    sessionId: memory.sessionIds?.[0] ?? "memory",
    timestamp: memory.createdAt,
    type: "decision",
    title: memory.title,
    facts: [memory.content],
    narrative: memory.content,
    concepts: memory.concepts,
    files: memory.files,
    importance: memory.strength,
  };
}
