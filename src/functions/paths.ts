//
// Path canonicalization for project/cwd scoping. The unified memory layer
// scopes recall by working directory, and tools report that directory in
// inconsistent forms: symlinked (/tmp -> /private/tmp on macOS), with or
// without a trailing slash, with `..` segments. Exact string comparison then
// silently misses — the worst failure mode for a memory layer, because it
// looks like "no memory" rather than an error.
//
// canonicalizePath resolves an absolute path to its real, symlink-free form
// so two spellings of the same directory compare equal. Non-absolute values
// (labels like "mcp", or "/work/alpha"-style virtual projects in tests) pass
// through unchanged, and a path that does not exist falls back to syntactic
// normalization. Applied to BOTH the query filter and the stored value at
// comparison time, so it is robust regardless of how the path was captured.

import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

// Cache only successfully-resolved (existing) paths: those are stable, while
// a not-yet-existing path might come to exist later and must re-resolve.
const cache = new Map<string, string>();

export function canonicalizePath(p: string | undefined | null): string {
  const s = (p ?? "").trim();
  if (!s || !isAbsolute(s)) return s;
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  try {
    const real = realpathSync(s);
    cache.set(s, real);
    return real;
  } catch {
    let n = normalize(s);
    if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
    return n;
  }
}
