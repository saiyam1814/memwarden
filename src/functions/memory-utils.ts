//
// Adapts a stored Memory into the CompressedObservation shape the search and
// enrichment paths expect. A Memory has no real session, so it borrows its
// first sessionId (or the literal "memory") as a synthetic key that
// KV.memories lookups fall back on.

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
