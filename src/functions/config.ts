//
// Config shim. Reads process.env directly; only the handful of
// flags the core functions consult are modelled here.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalizePath } from "./paths.js";

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
 * provider is wired in the core, so this is effectively always false here,
 * but the flag is reserved for when the model layer lands.
 */
export function isAutoCompressEnabled(): boolean {
  return flag("MEMWARDEN_AUTO_COMPRESS");
}

/** Memory slots are an optional context-injection feature, off by default. */
export function isSlotsEnabled(): boolean {
  return flag("MEMWARDEN_SLOTS");
}

// --- injection / capture switches -----------------------------------
//
// Users must be able to turn the automatic paths off — per environment via
// MEMWARDEN_INJECT / MEMWARDEN_CAPTURE, and per project via the excluded
// list. The switches gate the AUTOMATIC paths only (hooks, proxy); explicit
// asks (/recall, the MCP tools, the CLI) always work — turning off
// auto-inject must not lobotomize deliberate recall.

function offFlag(name: string): boolean {
  const v = (env(name) ?? "").trim().toLowerCase();
  return v === "off" || v === "false" || v === "0";
}

/** Auto-injection (SessionStart hook, Déjà Fix hook, proxy). Default on. */
export function isInjectEnabled(): boolean {
  return !offFlag("MEMWARDEN_INJECT");
}

/** Auto-capture (PostToolUse hook, proxy tee). Default on. */
export function isCaptureEnabled(): boolean {
  return !offFlag("MEMWARDEN_CAPTURE");
}

/** Where the brain lives. */
export function getDataDir(): string {
  return env("MEMWARDEN_DATA_DIR") ?? join(homedir(), ".memwarden");
}

/**
 * Per-project exclusion: `<dataDir>/excluded` holds one absolute path per
 * line (written by `memwarden exclude`). A cwd inside any excluded path is
 * excluded — capture AND injection, every automatic surface, so an excluded
 * project never reaches the brain and the brain never reaches it. Read on
 * every call (the file is tiny and the daemon is long-lived; a stale cache
 * here would mean "exclude" takes effect only on restart — the classic
 * excluded-but-not-really bug).
 */
export function isProjectExcluded(cwd: string | undefined): boolean {
  if (!cwd) return false;
  let lines: string[];
  try {
    const path = join(getDataDir(), "excluded");
    if (!existsSync(path)) return false;
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return false;
  }
  // Canonicalize both sides so /tmp vs /private/tmp (and trailing-slash)
  // spellings of the same directory still match — the same rule recall
  // scoping uses (see paths.ts).
  const target = canonicalizePath(cwd);
  if (!target) return false;
  for (const line of lines) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const ex = canonicalizePath(raw);
    if (!ex) continue;
    if (target === ex || target.startsWith(ex.endsWith("/") ? ex : ex + "/")) return true;
  }
  return false;
}

// The CLI (`memwarden up`) persists the generated secret to <dataDir>/secret.
// The daemon spawned by `up` inherits MEMWARDEN_SECRET via env, but short-lived
// clients launched by the agent host — the Claude Code hook runs in the user's
// shell, manually-started MCP servers — won't have that env. Without a fallback
// they'd call a secured daemon with no Bearer and silently 401 (auto-recall dies
// with no error). So resolution is: env first, then the persisted secret file.
// Read the file at most once per process (the secret is stable for its lifetime).
let cachedFileSecret: string | undefined | null = null; // null = not yet read

function persistedSecret(): string | undefined {
  if (cachedFileSecret !== null) return cachedFileSecret;
  cachedFileSecret = undefined;
  try {
    const dataDir = env("MEMWARDEN_DATA_DIR") ?? join(homedir(), ".memwarden");
    const path = join(dataDir, "secret");
    if (existsSync(path)) {
      const s = readFileSync(path, "utf8").trim();
      if (s) cachedFileSecret = s;
    }
  } catch {
    // Best-effort: an unreadable/absent file leaves the API open, exactly as
    // before this fallback existed.
  }
  return cachedFileSecret;
}

/**
 * The shared secret used by the api-auth middleware. When unset (no env var and
 * no persisted secret file) the API is open (absent secret = continue). The
 * daemon and every local client resolve it identically through this function.
 */
export function getSecret(): string | undefined {
  const fromEnv = env("MEMWARDEN_SECRET");
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return persistedSecret();
}

/**
 * TurboQuant vector quantization (arXiv:2504.19874): the vector index
 * stores 2/4-bit codes instead of full Float32 embeddings (~8-16x smaller).
 * This is memwarden's distinguishing storage layer, so it is ON BY DEFAULT
 * whenever an embedding provider is active — there is no reason to hold
 * full-precision vectors once semantic memory is on. Set
 * MEMWARDEN_QUANT_VECTOR=false to force the full-precision baseline, or
 * =true to force it on even without a provider (e.g. tests).
 */
export function isQuantizedVectorEnabled(): boolean {
  const raw = env("MEMWARDEN_QUANT_VECTOR");
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Unset: follow the embedding provider. Read the env directly to avoid a
  // config<->embedding import cycle.
  const provider = (process.env.MEMWARDEN_EMBEDDING_PROVIDER ?? "local")
    .trim()
    .toLowerCase();
  return provider !== "none";
}

/** Bits per dimension for the quantized index. 4 (default) or 2. */
export function getQuantBits(): 2 | 4 {
  return env("MEMWARDEN_QUANT_BITS") === "2" ? 2 : 4;
}

/**
 * Rescore depth: how many asymmetric-pass candidates get re-ranked with
 * exact cosine. 0 (default) disables rescore and drops full vectors from
 * memory entirely — the max-compression configuration.
 */
export function getQuantRescoreDepth(): number {
  const raw = env("MEMWARDEN_QUANT_RESCORE");
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Rotation seed; same seed reproduces the identical rotation everywhere. */
export function getQuantSeed(): string {
  return env("MEMWARDEN_QUANT_SEED") ?? "memwarden-tq-v1";
}

// --- memory proxy (the universal cross-tool layer) -----------------
//
// The OpenAI-compatible gateway. Any tool that lets you point at a custom
// base URL — Cursor, Continue, Cline, raw SDK apps — routes its model
// calls through memwarden, which injects relevant memory and captures the
// exchange. The model behind it can be local (Ollama :11434/v1, LM Studio
// :1234/v1) or paid (OpenAI, OpenRouter, Together); the proxy is blind to
// which, so it is one memory layer for all of them. The proxy is OFF until
// an upstream is configured (it has nothing to forward to otherwise).

/** Upstream OpenAI-compatible base URL, e.g. https://api.openai.com/v1. */
export function getUpstreamUrl(): string | undefined {
  const raw = env("MEMWARDEN_UPSTREAM_URL");
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

/** API key forwarded to the upstream as `Authorization: Bearer`. */
export function getUpstreamKey(): string | undefined {
  const raw = env("MEMWARDEN_UPSTREAM_KEY");
  return raw && raw.trim() ? raw.trim() : undefined;
}

/** Port the memory proxy listens on. Defaults to 3141. */
export function getProxyPort(): number {
  const raw = env("MEMWARDEN_PROXY_PORT");
  if (!raw) return 3141;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3141;
}

/** The proxy runs only once an upstream is configured to forward to. */
export function isProxyEnabled(): boolean {
  return getUpstreamUrl() !== undefined;
}
