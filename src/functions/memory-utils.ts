//
// Adapts a stored Memory into the CompressedObservation shape the search and
// enrichment paths expect. A Memory has no real session, so it borrows its
// first sessionId (or the literal "memory") as a synthetic key that
// KV.memories lookups fall back on.

import type { CompressedObservation, Memory } from "./types.js";

export function memoryToObservation(memory: Memory): CompressedObservation {
  const obs: CompressedObservation = {
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
  // Carry provenance so Memory records go through Verified Recall too. If a
  // record has no provenance but does reference files, synthesize a minimal
  // one so at least deletion is detected (content drift needs captured hashes).
  if (memory.provenance) {
    obs.provenance = memory.provenance;
  } else if (memory.files && memory.files.length > 0) {
    obs.provenance = { files: memory.files, command: "memory" };
  }
  return obs;
}
