//
// OS service installer — the crash/reboot self-heal. Registers the daemon
// with the platform supervisor so it starts at login and restarts if it
// dies, with no human in the loop:
//   macOS  ~/Library/LaunchAgents/ai.memwarden.daemon.plist  (launchd)
//   Linux  ~/.config/systemd/user/memwarden.service          (systemd --user)
//
// KeepAlive/Restart are set to "restart on FAILURE only" (SuccessfulExit
// false / on-failure), so a real crash (non-zero exit) IS relaunched.
//
// The supervised instance must also be the one that serves. If anything else
// starts a daemon first (an MCP server reviving the brain at login, say), the
// supervised instance used to exit 0 on EADDRINUSE and launchd/systemd
// treated the job as finished: the brain then ran unsupervised until the next
// login, and a crash meant silent capture loss. Two rules close that:
//   - every revival path goes through the supervisor when the service is
//     installed (startServiceViaSupervisor), so nothing races it;
//   - a supervised instance that finds another memwarden on its port waits in
//     standby and takes over when it exits (see index.ts).
// Best-effort: any failure returns ok:false so `up` falls back to a detached
// spawn.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DAEMON_ENTRY } from "./ensure.js";
import {
  DAEMON_LOG_MODE_ENV,
  DAEMON_LOG_MODE_FILE,
  DAEMON_LOG_MODE_JOURNALD,
  daemonLogPath,
  openSecureDaemonLog,
} from "./log.js";

const LABEL = "ai.memwarden.daemon";

export interface ServiceResult {
  kind: "launchd" | "systemd" | "unsupported";
  ok: boolean;
  path?: string;
  message: string;
}

type ServiceCommand = (command: string, args: string[]) => void;

interface ServiceRuntime {
  platform: NodeJS.Platform;
  home: string;
  node: string;
  run: ServiceCommand;
}

/** Test-only runtime: lets launchd installation stay entirely below a temp HOME. */
export interface ServiceTestRuntime {
  platform: NodeJS.Platform;
  home: string;
  node?: string;
  run?: ServiceCommand;
}

function productionRuntime(): ServiceRuntime {
  return {
    platform: process.platform,
    home: homedir(),
    node: process.execPath,
    run: (command, args) => {
      execFileSync(command, args, { stdio: "ignore" });
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}
function systemdPath(home: string): string {
  return join(home, ".config", "systemd", "user", "memwarden.service");
}

// XML-escape a value before interpolating it into the plist (the secret is
// base64url so it has no XML metacharacters, but be defensive).
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Tuning env vars the managed daemon must inherit from the `up` invocation —
// without this, `MEMWARDEN_VECTOR_BACKEND=turbovec memwarden up` installs a
// service that silently runs the default backend. Values are restricted to a
// safe charset since they land inside a plist/systemd unit.
const TUNING_ENV_KEYS = [
  "MEMWARDEN_VECTOR_BACKEND",
  "MEMWARDEN_EMBED_DTYPE",
  "MEMWARDEN_EMBEDDING_PROVIDER",
  "MEMWARDEN_QUANT_VECTOR",
  "MEMWARDEN_QUANT_BITS",
  "MEMWARDEN_QUANT_RESCORE",
  "MEMWARDEN_QUANT_SEED",
  "MEMWARDEN_PROXY_PORT",
  "MEMWARDEN_REST_PORT",
] as const;

/** Test-only export: the tuning-env passthrough with its charset guard. */
export function __tuningEnvForTests(): Array<[string, string]> {
  return tuningEnv();
}

function tuningEnv(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const key of TUNING_ENV_KEYS) {
    const v = process.env[key];
    if (v && /^[A-Za-z0-9._:/-]+$/.test(v)) out.push([key, v]);
  }
  return out;
}

function macPlist(node: string, dataDir: string, secret?: string): string {
  const log = daemonLogPath(dataDir);
  // The managed daemon resolves its auth secret from MEMWARDEN_SECRET, so it
  // must be in the service environment or a login-launched daemon would run
  // open. Only emitted when a secret was resolved.
  const secretEntry = secret
    ? `\n    <key>MEMWARDEN_SECRET</key><string>${xmlEscape(secret)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(DAEMON_ENTRY)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEMWARDEN_DATA_DIR</key><string>${xmlEscape(dataDir)}</string>
    <key>${DAEMON_LOG_MODE_ENV}</key><string>${DAEMON_LOG_MODE_FILE}</string>${secretEntry}${tuningEnv()
      .map(([k, v]) => `\n    <key>${k}</key><string>${xmlEscape(v)}</string>`)
      .join("")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

function systemdUnit(node: string, dataDir: string, secret?: string): string {
  // Same reason as the plist: the managed daemon needs MEMWARDEN_SECRET in its
  // environment to enforce auth. Only emitted when a secret was resolved.
  const secretEnv = secret
    ? `\nEnvironment=MEMWARDEN_SECRET=${secret}`
    : "";
  const tuning = tuningEnv()
    .map(([k, v]) => `\nEnvironment=${k}=${v}`)
    .join("");
  return `[Unit]
Description=memwarden memory daemon
After=network.target

[Service]
ExecStart=${node} ${DAEMON_ENTRY}
Environment=MEMWARDEN_DATA_DIR=${dataDir}
Environment=${DAEMON_LOG_MODE_ENV}=${DAEMON_LOG_MODE_JOURNALD}${secretEnv}${tuning}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/**
 * Install + start the supervised daemon for this platform. Best-effort. When
 * `secret` is provided it is baked into the service environment so the
 * login-launched daemon enforces auth (otherwise a managed daemon would run
 * open even though the CLI generated a secret).
 */
function installServiceWithRuntime(
  dataDir: string,
  secret: string | undefined,
  runtime: ServiceRuntime,
): ServiceResult {
  const { home, node, platform, run } = runtime;

  // The secret and dataDir are interpolated into generated service units. A
  // newline (or, on systemd, other control chars) would let a chosen value
  // inject extra directives — e.g. `--secret $'x\nExecStartPre=/bin/evil'`
  // would add a rogue ExecStartPre that runs at login. The auto-generated
  // secret is base64url (safe), but `--secret`/`MEMWARDEN_DATA_DIR` are
  // user-controlled, so reject anything with a newline/CR/NUL up front.
  const hasControlChar = (s: string): boolean => /[\r\n\0]/.test(s);
  if (hasControlChar(dataDir) || (secret !== undefined && hasControlChar(secret))) {
    return {
      kind: platform === "darwin" ? "launchd" : "systemd",
      ok: false,
      message: "refusing to install service: secret or data dir contains a newline/control character",
    };
  }

  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch {
    // non-fatal; the write below will surface a real error if the dir is bad
  }

  if (platform === "darwin") {
    const path = plistPath(home);
    try {
      // launchd opens StandardOutPath itself, so validate/create/chmod the real
      // fixed target before the plist is loaded. Failure is closed: no load.
      const log = openSecureDaemonLog(dataDir);
      log.close();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, macPlist(node, dataDir, secret), "utf8");
      // Lock the plist down: it now carries the secret in plaintext.
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort
      }
      try {
        run("launchctl", ["unload", path]);
      } catch {
        // not previously loaded — fine
      }
      run("launchctl", ["load", "-w", path]);
      return {
        kind: "launchd",
        ok: true,
        path,
        message: "starts at login, restarts on crash",
      };
    } catch (err) {
      return { kind: "launchd", ok: false, path, message: errMsg(err) };
    }
  }

  if (platform === "linux") {
    const path = systemdPath(home);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, systemdUnit(node, dataDir, secret), "utf8");
      // Lock the unit down: it now carries the secret in plaintext.
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort
      }
      run("systemctl", ["--user", "daemon-reload"]);
      run("systemctl", ["--user", "enable", "--now", "memwarden"]);
      return {
        kind: "systemd",
        ok: true,
        path,
        message: "starts at login, restarts on crash",
      };
    } catch (err) {
      return { kind: "systemd", ok: false, path, message: errMsg(err) };
    }
  }

  return {
    kind: "unsupported",
    ok: false,
    message: `no supported service manager for ${platform}`,
  };
}

/** Install using the real home, platform, executable, and service manager. */
export function installService(dataDir: string, secret?: string): ServiceResult {
  return installServiceWithRuntime(dataDir, secret, productionRuntime());
}

/** Temp-only launchd/systemd seam; never resolves the caller's real home. */
export function __installServiceForTests(
  dataDir: string,
  secret: string | undefined,
  testRuntime: ServiceTestRuntime,
): ServiceResult {
  return installServiceWithRuntime(dataDir, secret, {
    platform: testRuntime.platform,
    home: testRuntime.home,
    node: testRuntime.node ?? process.execPath,
    run: testRuntime.run ?? (() => undefined),
  });
}

/** Test-only generated-unit views; no filesystem or service-manager access. */
export function __macPlistForTests(
  node: string,
  dataDir: string,
  secret?: string,
): string {
  return macPlist(node, dataDir, secret);
}

export function __systemdUnitForTests(
  node: string,
  dataDir: string,
  secret?: string,
): string {
  return systemdUnit(node, dataDir, secret);
}

export type Supervisor = "launchd" | "systemd";

/**
 * Which supervisor launched THIS process, or null when it was started by
 * anything else (a detached spawn, a shell). launchd names the job in
 * XPC_SERVICE_NAME; our systemd unit is the only launcher that selects
 * journald logging, and systemd stamps every service with INVOCATION_ID.
 */
export function supervisorOf(env: NodeJS.ProcessEnv = process.env): Supervisor | null {
  if (env["XPC_SERVICE_NAME"] === LABEL) return "launchd";
  if (env["INVOCATION_ID"] && env[DAEMON_LOG_MODE_ENV] === DAEMON_LOG_MODE_JOURNALD) {
    return "systemd";
  }
  return null;
}

/** What an installed service runs: which supervisor, which brain, which port. */
export interface InstalledService {
  kind: Supervisor;
  path: string;
  dataDir: string;
  port: number;
}

const DEFAULT_REST_PORT = 3111;

function plistEnv(text: string, key: string): string | undefined {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
  if (!m) return undefined;
  return m[1]!
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function unitEnv(text: string, key: string): string | undefined {
  const m = new RegExp(`^Environment=${key}=(.*)$`, "m").exec(text);
  return m ? m[1]!.trim() : undefined;
}

function installedServiceWithRuntime(
  runtime: Pick<ServiceRuntime, "platform" | "home">,
): InstalledService | null {
  const { platform, home } = runtime;
  const kind: Supervisor | null =
    platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : null;
  if (!kind) return null;
  const path = kind === "launchd" ? plistPath(home) : systemdPath(home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const read = kind === "launchd" ? plistEnv : unitEnv;
  const dataDir = read(text, "MEMWARDEN_DATA_DIR");
  if (!dataDir) return null;
  const port = parseInt(read(text, "MEMWARDEN_REST_PORT") ?? `${DEFAULT_REST_PORT}`, 10);
  return {
    kind,
    path,
    dataDir: resolve(dataDir),
    port: Number.isFinite(port) ? port : DEFAULT_REST_PORT,
  };
}

/** The installed service for this user, or null when there is none. */
export function installedService(): InstalledService | null {
  return installedServiceWithRuntime(productionRuntime());
}

/** Does the installed service serve exactly this brain on this URL's port? */
export function serviceServes(svc: InstalledService, url: string, dataDir: string): boolean {
  let port: number;
  try {
    const u = new URL(url);
    port = u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return false;
  }
  return port === svc.port && resolve(dataDir) === svc.dataDir;
}

function startViaSupervisorWithRuntime(
  svc: InstalledService,
  runtime: Pick<ServiceRuntime, "run">,
): boolean {
  try {
    if (svc.kind === "launchd") {
      // kickstart without -k: starts the job if it is not running, and is a
      // no-op when it already is (so a revival never restarts a live daemon).
      runtime.run("launchctl", ["kickstart", `gui/${userInfo().uid}/${LABEL}`]);
    } else {
      runtime.run("systemctl", ["--user", "start", "memwarden"]);
    }
    return true;
  } catch {
    return false;
  }
}

/** Ask the supervisor to start its daemon. False when it could not be asked. */
export function startServiceViaSupervisor(svc: InstalledService): boolean {
  return startViaSupervisorWithRuntime(svc, productionRuntime());
}

/** Test-only seams for the supervisor helpers; never touch the real home. */
export function __installedServiceForTests(
  platform: NodeJS.Platform,
  home: string,
): InstalledService | null {
  return installedServiceWithRuntime({ platform, home });
}

export function __startViaSupervisorForTests(
  svc: InstalledService,
  run: ServiceCommand,
): boolean {
  return startViaSupervisorWithRuntime(svc, { run });
}

/** Stop + remove the supervised daemon. Best-effort. */
export function uninstallService(): ServiceResult {
  const home = homedir();
  if (process.platform === "darwin") {
    const path = plistPath(home);
    try {
      try {
        execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
      } catch {
        // not loaded
      }
      rmSync(path, { force: true });
      return { kind: "launchd", ok: true, path, message: "removed" };
    } catch (err) {
      return { kind: "launchd", ok: false, path, message: errMsg(err) };
    }
  }
  if (process.platform === "linux") {
    const path = systemdPath(home);
    try {
      try {
        execFileSync("systemctl", ["--user", "disable", "--now", "memwarden"], {
          stdio: "ignore",
        });
      } catch {
        // not enabled
      }
      rmSync(path, { force: true });
      return { kind: "systemd", ok: true, path, message: "removed" };
    } catch (err) {
      return { kind: "systemd", ok: false, path, message: errMsg(err) };
    }
  }
  return {
    kind: "unsupported",
    ok: false,
    message: `no supported service manager for ${process.platform}`,
  };
}
