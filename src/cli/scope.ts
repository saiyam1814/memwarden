//
// Daemon-target scoping: is this invocation aimed at the ONE user-global
// daemon, or at a non-default (throwaway/experimental) one?
//
// Lives in its own module — NOT in bin.ts — because bin.ts runs main() at
// module top level: anything that imports it (a test, another module wanting
// this predicate) would execute the whole CLI as a side effect.
//

export const DEFAULT_URL = "http://localhost:3111";
export const DEFAULT_PORT = "3111";

/**
 * Normalize a daemon URL for comparison: lowercase scheme/host, loopback
 * aliases (127.0.0.1, ::1) folded into localhost, trailing slash dropped,
 * explicit port always present. Unparseable input returns null, which the
 * guard treats as non-default — refusing global writes is the safe failure
 * direction.
 */
export function normalizeDaemonUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    let host = u.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      host = "localhost";
    }
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${u.protocol}//${host}:${port}`;
  } catch {
    return null;
  }
}

const DEFAULT_URL_NORMALIZED = normalizeDaemonUrl(DEFAULT_URL);

/**
 * Is this invocation aimed at the ONE user-global daemon — default URL, default
 * port?
 *
 * MEMWARDEN_URL / MEMWARDEN_REST_PORT scope the DAEMON, and it is natural to
 * assume they scope everything. They do not. The service (launchd/systemd) and
 * every tool's user-scope config are user-global, and the wiring BAKES THIS
 * RUN'S URL AND SECRET INTO THEM — so `up` against a throwaway daemon on :3199
 * repoints the user's real tools at it, and when that daemon goes away every
 * tool is left aimed at a dead port. `down` is worse: it would unload the real
 * service as a side effect of tidying up an experiment.
 *
 * Deliberately keyed on URL/PORT only, NOT on MEMWARDEN_DATA_DIR. A relocated
 * brain on the default port is a legitimate permanent install whose tools
 * should still be wired to :3111 — blocking that would break those users. The
 * harm comes exclusively from baking a NON-DEFAULT ADDRESS into global config.
 *
 * Conservative: only an explicit override that DIFFERS from the default counts;
 * unset or default-valued vars are the default daemon.
 */
export function targetsDefaultDaemon(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = env["MEMWARDEN_URL"];
  if (url && url.trim() && normalizeDaemonUrl(url) !== DEFAULT_URL_NORMALIZED) {
    return false;
  }
  const port = env["MEMWARDEN_REST_PORT"];
  if (port && port.trim() && port.trim() !== DEFAULT_PORT) return false;
  return true;
}

/** One-line description of the override, for `up`/`down` messages. */
export function nonDefaultTarget(env: NodeJS.ProcessEnv = process.env): string {
  const bits: string[] = [];
  if (env["MEMWARDEN_URL"]) bits.push(`MEMWARDEN_URL=${env["MEMWARDEN_URL"]}`);
  if (env["MEMWARDEN_REST_PORT"]) bits.push(`MEMWARDEN_REST_PORT=${env["MEMWARDEN_REST_PORT"]}`);
  return bits.join(" ");
}
