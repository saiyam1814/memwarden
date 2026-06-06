//
// Phase-0 config shim. Reads process.env directly; only the handful of
// flags the core functions consult are modelled here.

function env(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined ? v : undefined;
}

function flag(name: string): boolean {
  return env(name) === "true";
}

/** Default per-request context token budget. */
export function getTokenBudget(): number {
  const raw = env("MEMWARDEN_TOKEN_BUDGET");
  if (!raw) return 2000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

/** Max observations retained per session before mem::observe refuses more. */
export function getMaxObservationsPerSession(): number {
  const raw = env("MEMWARDEN_MAX_OBSERVATIONS_PER_SESSION");
  if (!raw) return 10000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

/**
 * The session's agentId source when no session row exists yet. Trimmed and
 * capped at 128 chars.
 */
export function getAgentId(): string | undefined {
  const raw = env("MEMWARDEN_AGENT_ID");
  if (!raw) return undefined;
  const agentId = raw.trim().slice(0, 128);
  return agentId || undefined;
}

/**
 * Per-observation LLM compression is opt-in. When false (the default)
 * mem::observe takes the zero-LLM synthetic-compression path. No LLM
 * provider is wired in Phase 0, so this is effectively always false here,
 * but the flag is reserved for when the model layer lands.
 */
export function isAutoCompressEnabled(): boolean {
  return flag("MEMWARDEN_AUTO_COMPRESS");
}

/** Memory slots are an optional context-injection feature, off by default. */
export function isSlotsEnabled(): boolean {
  return flag("MEMWARDEN_SLOTS");
}

/**
 * The shared secret used by the api-auth middleware. When unset the API is
 * open (absent secret = continue).
 */
export function getSecret(): string | undefined {
  return env("MEMWARDEN_SECRET");
}
