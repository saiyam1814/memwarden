//
// Project identity: a stable key for "the same project" that survives git
// worktrees, clones at different paths, and moved checkouts. Path scoping
// (paths.ts) treats /repo and /repo-worktree-b as unrelated even when they
// are the same repository — the memory looks gone, the worst failure mode.
//
// The key is derived, in order of preference:
//   1. the normalized git remote URL (origin first)   -> "git:github.com/u/r"
//   2. a remote-less repo: its MAIN repository root   -> "gitroot:/abs/main"
//      (worktrees resolve `.git` files to the main .git dir, so every
//       worktree of one repo shares the key)
//   3. not a repo at all: null — callers fall back to the canonical path.
//
// ADDITIVE ONLY: the key is stored alongside (never instead of) the existing
// project/cwd path fields, and recall uses it only to WIDEN path scoping —
// data without a key keeps matching exactly as before.
//
// No child processes: hooks fire on every tool call, so this reads .git
// files directly (cheap, no `git` binary dependency) and memoizes per cwd.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalizePath } from "./paths.js";

/**
 * Normalize a git remote URL to `host/path`, lowercased, credentials and the
 * `.git` suffix stripped. Handles the two forms git itself writes: scp-like
 * (`git@host:path`) and protocol URLs (`ssh://`, `https://`, `git://`).
 * Returns null for anything else (file remotes, relative paths) — those are
 * machine-local and no better than the repo-root fallback.
 */
export function normalizeGitRemote(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let host: string;
  let path: string;
  const proto = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(trimmed);
  const scp = /^(?:[^@/]+@)?([^:/]+\.[^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (proto) {
    host = proto[1]!;
    path = proto[2]!;
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  host = host.replace(/:\d+$/, ""); // port is transport detail, not identity
  path = path.replace(/\.git\/?$/, "").replace(/\/+$/, "").replace(/^\/+/, "");
  if (!host || !path) return null;
  return `${host}/${path}`.toLowerCase();
}

/** Walk up from `startDir` to the nearest directory containing `.git`. */
function findGitEntry(startDir: string): { root: string; entry: string } | null {
  let dir = resolve(startDir);
  for (;;) {
    const entry = join(dir, ".git");
    if (existsSync(entry)) return { root: dir, entry };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the MAIN .git directory, following a worktree's `.git` file
 * (`gitdir: <main>/.git/worktrees/<name>`) back to `<main>/.git` so all
 * worktrees of one repository resolve to the same place.
 */
function mainGitDir(root: string, entry: string): string | null {
  try {
    if (statSync(entry).isDirectory()) return entry;
    const content = readFileSync(entry, "utf8");
    const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
    if (!m) return null;
    const pointed = isAbsolute(m[1]!) ? m[1]! : resolve(root, m[1]!);
    const wt = /^(.*[\\/]\.git)[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(pointed);
    return wt ? wt[1]! : pointed;
  } catch {
    return null;
  }
}

/**
 * Extract the `origin` remote URL (or, failing that, the first remote) from
 * git config text. Line-oriented on purpose: enough for the exact
 * `[remote "x"]` / `url = …` shape git writes, with no INI parser dependency.
 */
export function remoteUrlFromConfig(config: string): string | null {
  let section: string | null = null;
  let firstUrl: string | null = null;
  for (const line of config.split("\n")) {
    const header = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      section = null;
      continue;
    }
    if (!section) continue;
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (!url) continue;
    if (section === "origin") return url[1]!;
    if (firstUrl === null) firstUrl = url[1]!;
  }
  return firstUrl;
}

// Hooks call this on every tool event; the answer for a directory is stable
// for the life of a daemon/CLI process, so memoize per cwd.
const keyCache = new Map<string, string | null>();

/**
 * The git-derived project key for a directory, or null when it is not inside
 * a git repository (callers fall back to the canonical path).
 */
export function gitProjectKey(cwd: string): string | null {
  const dir = (cwd ?? "").trim();
  if (!dir || !isAbsolute(dir)) return null;
  const hit = keyCache.get(dir);
  if (hit !== undefined) return hit;
  let key: string | null = null;
  try {
    const found = findGitEntry(dir);
    if (found) {
      const gitDir = mainGitDir(found.root, found.entry);
      if (gitDir) {
        const configPath = join(gitDir, "config");
        const remote = existsSync(configPath)
          ? remoteUrlFromConfig(readFileSync(configPath, "utf8"))
          : null;
        const normalized = remote ? normalizeGitRemote(remote) : null;
        key = normalized
          ? `git:${normalized}`
          : `gitroot:${canonicalizePath(dirname(gitDir))}`;
      }
    }
  } catch {
    key = null;
  }
  keyCache.set(dir, key);
  return key;
}

/**
 * The stable project key for a directory: git identity when available,
 * canonical path otherwise. Never empty for a non-empty input.
 */
export function projectKey(cwd: string): string {
  return gitProjectKey(cwd) ?? canonicalizePath(cwd);
}

/** Test hook: drop the memo (temp repos are created and deleted per test). */
export function __resetGitIdentityCache(): void {
  keyCache.clear();
}
