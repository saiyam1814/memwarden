//
// Project identity: normalized git remote / main-repo-root keys that survive
// worktrees and moved checkouts. All filesystem cases run against synthetic
// .git layouts in a temp dir (no `git` binary, matching the implementation).

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeGitRemote,
  remoteUrlFromConfig,
  gitProjectKey,
  projectKey,
  __resetGitIdentityCache,
} from "../src/functions/git-identity.js";

const dirs: string[] = [];
function tempDir(): string {
  // realpath so macOS /tmp -> /private/tmp symlinks don't skew comparisons.
  const d = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-git-id-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  __resetGitIdentityCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("normalizeGitRemote", () => {
  it("normalizes every spelling of the same repo to one key", () => {
    const expected = "github.com/acme/rocket";
    for (const url of [
      "git@github.com:acme/rocket.git",
      "https://github.com/acme/rocket.git",
      "https://github.com/acme/rocket",
      "ssh://git@github.com/acme/rocket.git",
      "https://user:token@github.com/acme/rocket.git",
      "ssh://git@github.com:22/acme/rocket.git",
      "git@GitHub.com:Acme/Rocket.git",
    ]) {
      expect(normalizeGitRemote(url), url).toBe(expected);
    }
  });

  it("keeps nested groups and self-hosted hosts", () => {
    expect(normalizeGitRemote("git@gitlab.example.io:group/sub/repo.git")).toBe(
      "gitlab.example.io/group/sub/repo",
    );
  });

  it("returns null for file/local/unrecognized remotes", () => {
    expect(normalizeGitRemote("/abs/local/repo.git")).toBeNull();
    expect(normalizeGitRemote("file:///abs/local/repo.git")).toBeNull();
    expect(normalizeGitRemote("../relative/repo")).toBeNull();
    expect(normalizeGitRemote("")).toBeNull();
  });
});

describe("remoteUrlFromConfig", () => {
  it("prefers origin over other remotes regardless of order", () => {
    const config = [
      "[core]",
      "\trepositoryformatversion = 0",
      '[remote "upstream"]',
      "\turl = git@github.com:acme/upstream.git",
      '[remote "origin"]',
      "\turl = git@github.com:acme/rocket.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    ].join("\n");
    expect(remoteUrlFromConfig(config)).toBe("git@github.com:acme/rocket.git");
  });

  it("falls back to the first remote when origin is absent; null when none", () => {
    expect(
      remoteUrlFromConfig('[remote "fork"]\n\turl = git@h.io:a/b.git\n'),
    ).toBe("git@h.io:a/b.git");
    expect(remoteUrlFromConfig("[core]\n\tbare = false\n")).toBeNull();
  });
});

// Build a synthetic main repo (+ optional linked worktree) on disk.
function makeRepo(base: string, remote?: string): { main: string; worktree: string } {
  const main = join(base, "main");
  mkdirSync(join(main, ".git", "worktrees", "wt-b"), { recursive: true });
  writeFileSync(
    join(main, ".git", "config"),
    remote ? `[remote "origin"]\n\turl = ${remote}\n` : "[core]\n\tbare = false\n",
    "utf8",
  );
  // Linked worktree: .git is a FILE pointing into the main repo's .git dir.
  const worktree = join(base, "wt-b");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(
    join(worktree, ".git"),
    `gitdir: ${join(main, ".git", "worktrees", "wt-b")}\n`,
    "utf8",
  );
  return { main, worktree };
}

describe("gitProjectKey / projectKey", () => {
  it("main repo and its linked worktree share the remote-derived key", () => {
    const base = tempDir();
    const { main, worktree } = makeRepo(base, "git@github.com:acme/rocket.git");
    expect(gitProjectKey(main)).toBe("git:github.com/acme/rocket");
    expect(gitProjectKey(worktree)).toBe("git:github.com/acme/rocket");
    // and from a subdirectory of either
    const sub = join(worktree, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(gitProjectKey(sub)).toBe("git:github.com/acme/rocket");
  });

  it("a remote-less repo keys on its MAIN root, shared by worktrees", () => {
    const base = tempDir();
    const { main, worktree } = makeRepo(base); // no remote
    expect(gitProjectKey(main)).toBe(`gitroot:${main}`);
    expect(gitProjectKey(worktree)).toBe(`gitroot:${main}`);
  });

  it("a non-repo directory yields null; projectKey falls back to the canonical path", () => {
    const dir = tempDir();
    expect(gitProjectKey(dir)).toBeNull();
    expect(projectKey(dir)).toBe(dir);
  });

  it("never throws on garbage input or unreadable layouts", () => {
    expect(gitProjectKey("")).toBeNull();
    expect(gitProjectKey("relative/path")).toBeNull();
    const dir = tempDir();
    writeFileSync(join(dir, ".git"), "not a gitdir pointer", "utf8");
    expect(gitProjectKey(dir)).toBeNull();
    expect(projectKey(dir)).toBe(dir);
  });
});
