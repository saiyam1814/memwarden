//
// Redacts secrets from raw observation text before anything is persisted:
// any span the user wraps in <private>...</private>, plus a set of well-known
// credential formats (provider API keys, bearer tokens, JWTs, cloud keys).
// The credential shapes are public, factual patterns.

const PRIVATE_SPAN = /<private>[\s\S]*?<\/private>/gi;

const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:api[_-]?key|secret|token|password|credential|auth)\s*[=:]\s*["']?[A-Za-z0-9_\-/.+]{20,}["']?/gi,
  /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
  /sk-proj-[A-Za-z0-9\-_]{20,}/g,
  /(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/g,
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  /gh[pus]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /xoxb-[A-Za-z0-9\-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[A-Za-z0-9\-_]{35}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /glpat-[A-Za-z0-9\-_]{20,}/g,
  /dop_v1_[A-Za-z0-9]{64}/g,
];

export function stripPrivateData(input: string): string {
  let out = input.replace(PRIVATE_SPAN, "[REDACTED]");
  for (const pattern of SECRET_PATTERNS) {
    // Fresh RegExp per pass to avoid any shared lastIndex state.
    out = out.replace(new RegExp(pattern.source, pattern.flags), "[REDACTED_SECRET]");
  }
  return out;
}
