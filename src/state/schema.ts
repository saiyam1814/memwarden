//
// The single source of truth for KV scope names, plus a few pure id and
// similarity helpers. Scopes are exact-match strings (no prefix hierarchy):
// list(scope) returns just that scope's values, and cross-session enumeration
// is list(KV.sessions) followed by list(KV.observations(id)) per session.

import { createHash, randomUUID } from "node:crypto";

export const KV = {
  sessions: "mem:sessions",
  observations: (sessionId: string) => `mem:obs:${sessionId}`,
  memories: "mem:memories",
  summaries: "mem:summaries",
  config: "mem:config",
  metrics: "mem:metrics",
  health: "mem:health",
  embeddings: (obsId: string) => `mem:emb:${obsId}`,
  bm25Index: "mem:index:bm25",
  relations: "mem:relations",
  profiles: "mem:profiles",
  claudeBridge: "mem:claude-bridge",
  graphNodes: "mem:graph:nodes",
  graphEdges: "mem:graph:edges",
  semantic: "mem:semantic",
  procedural: "mem:procedural",
  teamShared: (teamId: string) => `mem:team:${teamId}:shared`,
  teamUsers: (teamId: string, userId: string) =>
    `mem:team:${teamId}:users:${userId}`,
  teamProfile: (teamId: string) => `mem:team:${teamId}:profile`,
  audit: "mem:audit",
  actions: "mem:actions",
  actionEdges: "mem:action-edges",
  leases: "mem:leases",
  routines: "mem:routines",
  routineRuns: "mem:routine-runs",
  signals: "mem:signals",
  checkpoints: "mem:checkpoints",
  mesh: "mem:mesh",
  sketches: "mem:sketches",
  facets: "mem:facets",
  sentinels: "mem:sentinels",
  crystals: "mem:crystals",
  lessons: "mem:lessons",
  insights: "mem:insights",
  graphEdgeHistory: "mem:graph:edge-history",
  enrichedChunks: (sessionId: string) => `mem:enriched:${sessionId}`,
  // Reserved per-observation quantized codes; Phase 0b persists the whole
  // quantized index as one blob under `quantParams` instead.
  latentEmbeddings: (obsId: string) => `mem:latent:${obsId}`,
  quantParams: "mem:quant:params",
  retentionScores: "mem:retention",
  accessLog: "mem:access",
  imageRefs: "mem:image-refs",
  imageEmbeddings: "mem:image-embeddings",
  slots: "mem:slots",
  globalSlots: "mem:slots:global",
  state: "mem:state",
  commits: "mem:commits",
  recentSearches: "mem:recent-searches",
} as const;

export const STREAM = {
  name: "mem-live",
  group: (sessionId: string) => sessionId,
  viewerGroup: "viewer",
} as const;

/** A sortable, collision-resistant id: prefix + base36 time + random tail. */
export function generateId(prefix: string): string {
  const time = Date.now().toString(36);
  const tail = randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}_${time}_${tail}`;
}

/** A deterministic id derived from content (same content -> same id). */
export function fingerprintId(prefix: string, content: string): string {
  const digest = createHash("sha256").update(content).digest("hex");
  return `${prefix}_${digest.slice(0, 16)}`;
}

/** Word-set Jaccard overlap, ignoring tokens of 2 characters or fewer. */
export function jaccardSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(s.split(/\s+/).filter((t) => t.length > 2));
  const left = words(a);
  const right = words(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared++;
  return shared / (left.size + right.size - shared);
}
