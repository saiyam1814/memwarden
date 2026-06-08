//
// Query-time synonym expansion for BM25. Each group below is a set of common
// developer terms that should match one another (abbreviation, full word,
// inflections). Groups are stemmed once at load so lookups key off the same
// stems the tokenizer emits; the BM25 scorer weights expanded hits below
// exact ones.

import { stem } from "./stemmer.js";

// Factual term associations (dev abbreviations and their expansions).
const GROUPS: ReadonlyArray<readonly string[]> = [
  ["auth", "authentication", "authn", "authenticating"],
  ["authz", "authorization", "authorizing"],
  ["db", "database", "datastore"],
  ["perf", "performance", "latency", "throughput", "slow", "bottleneck"],
  ["optim", "optimization", "optimizing", "optimise", "query-optimization"],
  ["k8s", "kubernetes", "kube"],
  ["config", "configuration", "configuring", "setup"],
  ["deps", "dependencies", "dependency"],
  ["env", "environment"],
  ["fn", "function"],
  ["impl", "implementation", "implementing"],
  ["msg", "message", "messaging"],
  ["repo", "repository"],
  ["req", "request"],
  ["res", "response"],
  ["ts", "typescript"],
  ["js", "javascript"],
  ["pg", "postgres", "postgresql"],
  ["err", "error", "errors"],
  ["api", "endpoint", "endpoints"],
  ["ci", "continuous-integration"],
  ["cd", "continuous-deployment"],
  ["test", "testing", "tests"],
  ["doc", "documentation", "docs"],
  ["infra", "infrastructure"],
  ["deploy", "deployment", "deploying"],
  ["cache", "caching", "cached"],
  ["log", "logging", "logs"],
  ["monitor", "monitoring"],
  ["observe", "observability"],
  ["sec", "security", "secure"],
  ["validate", "validation", "validating"],
  ["migrate", "migration", "migrations"],
  ["debug", "debugging"],
  ["container", "containerization", "docker"],
  ["crash", "crashloop", "crashloopbackoff"],
  ["webhook", "webhooks", "callback"],
  ["middleware", "mw"],
  ["paginate", "pagination"],
  ["serialize", "serialization"],
  ["encrypt", "encryption"],
  ["hash", "hashing"],
];

// stem -> the other stems in its group
const byStem = new Map<string, Set<string>>();
for (const group of GROUPS) {
  const stems = [...new Set(group.map((term) => stem(term.toLowerCase())))];
  for (const s of stems) {
    let bucket = byStem.get(s);
    if (!bucket) byStem.set(s, (bucket = new Set()));
    for (const other of stems) if (other !== s) bucket.add(other);
  }
}

export function getSynonyms(stemmedTerm: string): string[] {
  const bucket = byStem.get(stemmedTerm);
  return bucket ? [...bucket] : [];
}
