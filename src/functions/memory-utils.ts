//
// Adapts a stored Memory into the CompressedObservation shape the search and
// enrichment paths expect. A Memory has no real session, so it borrows its
// first sessionId (or the literal "memory") as a synthetic key that
// KV.memories lookups fall back on.

import type { CompressedObservation, Memory } from "./types.js";

export function isMemoryExpired(memory: Memory, now = Date.now()): boolean {
  if (!memory.forgetAfter) return false;
  const expiresAt = new Date(memory.forgetAfter).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export function isMemoryRecallable(memory: Memory, now = Date.now()): boolean {
  return memory.isLatest !== false && !isMemoryExpired(memory, now);
}

export function memoryToObservation(
  memory: Memory,
  resolved?: { captureCwd?: string },
): CompressedObservation {
  const obs: CompressedObservation = {
    id: memory.id,
    sessionId:
      memory.origin === "manual"
        ? `memory:${memory.id}`
        : (memory.sessionIds?.[0] ?? "memory"),
    timestamp: memory.createdAt,
    type: "decision",
    title: memory.title,
    facts: memory.facts ?? [memory.content],
    narrative: memory.content,
    concepts: memory.concepts,
    files: memory.files,
    importance: memory.strength,
    ...(memory.subtitle !== undefined ? { subtitle: memory.subtitle } : {}),
    ...(memory.confidence !== undefined ? { confidence: memory.confidence } : {}),
    ...(memory.imageRef !== undefined ? { imageRef: memory.imageRef } : {}),
    ...(memory.imageData !== undefined ? { imageData: memory.imageData } : {}),
    ...(memory.imageDescription !== undefined
      ? { imageDescription: memory.imageDescription }
      : {}),
    ...(memory.modality !== undefined ? { modality: memory.modality } : {}),
    ...(memory.agentId !== undefined ? { agentId: memory.agentId } : {}),
  };
  // Carry provenance so Memory records go through Verified Recall too. If a
  // record has no provenance but does reference files, synthesize a minimal
  // one so at least deletion is detected (content drift needs captured hashes).
  const captureCwd = resolved?.captureCwd ?? memory.captureCwd;
  if (memory.provenance) {
    obs.provenance =
      captureCwd && !memory.provenance.cwd
        ? { ...memory.provenance, cwd: captureCwd }
        : memory.provenance;
  } else if (memory.files && memory.files.length > 0) {
    obs.provenance = {
      files: memory.files,
      command: "memory",
      ...(captureCwd ? { cwd: captureCwd } : {}),
    };
  }
  return obs;
}
