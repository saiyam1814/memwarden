//
// Semantic runtime: makes local embeddings work after a normal install.
//
// '@huggingface/transformers' is deliberately NOT a dependency of the npm
// package — it would turn a 28MB install into a ~250MB one and slow the
// `npx memwarden audit` funnel to a crawl. Instead `memwarden up` installs
// it ONCE into <dataDir>/runtime (npm --prefix), and the embedding loader
// falls back to that location when the bare specifier doesn't resolve.
// Everything stays honest: if neither resolves, the daemon says
// "lexical-only" instead of silently degrading.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const PKG = "@huggingface/transformers";
const PKG_SPEC = "@huggingface/transformers@^3.8.1";

/** Where `memwarden up` installs the optional embedding runtime. */
export function semanticRuntimeRoot(dataDir?: string): string {
  const base =
    dataDir ?? process.env.MEMWARDEN_DATA_DIR ?? join(homedir(), ".memwarden");
  return join(base, "runtime");
}

/**
 * Locate the transformers.js Node ESM entry inside a runtime root, without
 * going through the exports map (package.json isn't an exported subpath).
 * Returns an absolute file path, or null when not installed there.
 */
export function resolveTransformersEntry(root: string): string | null {
  const pkgDir = join(root, "node_modules", "@huggingface", "transformers");
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      exports?: { node?: { import?: { default?: string } } };
      module?: string;
      main?: string;
    };
    const rel =
      pkg.exports?.node?.import?.default ?? pkg.module ?? pkg.main ?? null;
    if (!rel) return null;
    const entry = join(pkgDir, rel);
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Import transformers.js: bare specifier first (dev checkouts, users who
 * installed it themselves), then the memwarden runtime dir. Throws with an
 * actionable message when neither resolves.
 */
export async function importTransformers(): Promise<{ pipeline?: unknown }> {
  const specifier = PKG;
  try {
    return (await import(specifier)) as { pipeline?: unknown };
  } catch {
    // fall through to the runtime root
  }
  const entry = resolveTransformersEntry(semanticRuntimeRoot());
  if (entry) {
    const mod = (await import(pathToFileURL(entry).href)) as {
      pipeline?: unknown;
      default?: { pipeline?: unknown };
    };
    // Tolerate CJS/ESM interop: pipeline may sit on the default export.
    if (typeof mod.pipeline === "function") return mod;
    if (typeof mod.default?.pipeline === "function") return mod.default;
    return mod;
  }
  throw new Error(
    `Local embeddings require '${PKG}'. Run 'memwarden up' to install it ` +
      `into ${semanticRuntimeRoot()}, or: npm install ${PKG}`,
  );
}

export interface RuntimeInstallResult {
  ok: boolean;
  message: string;
}

/**
 * Install the embedding runtime under <dataDir>/runtime via npm --prefix.
 * Synchronous on purpose: `up` is an interactive command and the install is
 * its longest step — stream npm's own progress to the terminal.
 */
export function installSemanticRuntime(dataDir?: string): RuntimeInstallResult {
  const root = semanticRuntimeRoot(dataDir);
  const args = [
    "install",
    "--prefix",
    root,
    "--no-fund",
    "--no-audit",
    "--loglevel=error",
    PKG_SPEC,
  ];
  // npm is npm.cmd on Windows and .cmd files only run through a shell.
  const win = process.platform === "win32";
  const r = spawnSync(win ? "npm.cmd" : "npm", win ? args.map(quoteWin) : args, {
    stdio: ["ignore", "inherit", "inherit"],
    shell: win,
    timeout: 10 * 60 * 1000,
  });
  if (r.error) return { ok: false, message: r.error.message };
  if (r.status !== 0) return { ok: false, message: `npm exited ${r.status}` };
  return resolveTransformersEntry(root)
    ? { ok: true, message: root }
    : { ok: false, message: `npm succeeded but ${PKG} is not resolvable in ${root}` };
}

// Windows shell invocation: quote anything with spaces (e.g. the --prefix
// path under C:\Users\First Last\...).
function quoteWin(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

const TURBOVEC_PKG = "@memwarden/turbovec";

/** Is the native vector engine already present in the runtime dir? */
export function turbovecInstalled(dataDir?: string): boolean {
  return existsSync(
    join(semanticRuntimeRoot(dataDir), "node_modules", "@memwarden", "turbovec"),
  );
}

/**
 * Install the optional native vector engine into <dataDir>/runtime. Quiet:
 * npm output is captured, not streamed — an unpublished package or an
 * offline machine is a normal outcome the caller reports honestly, not an
 * error wall. The daemon's boot probe remains the source of truth for which
 * engine actually serves.
 */
export function installTurbovecRuntime(dataDir?: string): RuntimeInstallResult {
  const root = semanticRuntimeRoot(dataDir);
  const args = [
    "install",
    "--prefix",
    root,
    "--no-fund",
    "--no-audit",
    "--loglevel=error",
    `${TURBOVEC_PKG}@^0.1`,
  ];
  const win = process.platform === "win32";
  const r = spawnSync(win ? "npm.cmd" : "npm", win ? args.map(quoteWin) : args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: win,
    timeout: 5 * 60 * 1000,
  });
  if (r.error) return { ok: false, message: r.error.message };
  if (r.status !== 0) {
    const err = (r.stderr?.toString() ?? "").trim();
    return {
      ok: false,
      message: /E404|404 Not Found/i.test(err)
        ? "not yet published to npm"
        : `npm exited ${r.status}`,
    };
  }
  return turbovecInstalled(dataDir)
    ? { ok: true, message: root }
    : { ok: false, message: `npm succeeded but ${TURBOVEC_PKG} is not present in ${root}` };
}
