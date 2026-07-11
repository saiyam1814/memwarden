//
// OS service installer — the crash/reboot self-heal. Registers the daemon
// with the platform supervisor so it starts at login and restarts if it
// dies, with no human in the loop:
//   macOS  ~/Library/LaunchAgents/ai.memwarden.daemon.plist  (launchd)
//   Linux  ~/.config/systemd/user/memwarden.service          (systemd --user)
//
// KeepAlive/Restart are set to "restart on FAILURE only" (SuccessfulExit
// false / on-failure). That pairs with the daemon's clean exit(0) on
// EADDRINUSE: if another instance already holds the port, the supervised one
// exits cleanly and is NOT relaunched (no crash loop); a real crash (non-zero
// exit) IS relaunched. Best-effort: any failure returns ok:false so `up`
// falls back to a detached spawn.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DAEMON_ENTRY } from "./ensure.js";

const LABEL = "ai.memwarden.daemon";

export interface ServiceResult {
  kind: "launchd" | "systemd" | "unsupported";
  ok: boolean;
  path?: string;
  message: string;
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
  const log = join(dataDir, "daemon.log");
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
    <string>${node}</string>
    <string>${DAEMON_ENTRY}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEMWARDEN_DATA_DIR</key><string>${dataDir}</string>${secretEntry}${tuningEnv()
      .map(([k, v]) => `\n    <key>${k}</key><string>${xmlEscape(v)}</string>`)
      .join("")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
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
Environment=MEMWARDEN_DATA_DIR=${dataDir}${secretEnv}${tuning}
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
export function installService(dataDir: string, secret?: string): ServiceResult {
  const home = homedir();
  const node = process.execPath;

  // The secret and dataDir are interpolated into generated service units. A
  // newline (or, on systemd, other control chars) would let a chosen value
  // inject extra directives — e.g. `--secret $'x\nExecStartPre=/bin/evil'`
  // would add a rogue ExecStartPre that runs at login. The auto-generated
  // secret is base64url (safe), but `--secret`/`MEMWARDEN_DATA_DIR` are
  // user-controlled, so reject anything with a newline/CR/NUL up front.
  const hasControlChar = (s: string): boolean => /[\r\n\0]/.test(s);
  if (hasControlChar(dataDir) || (secret !== undefined && hasControlChar(secret))) {
    return {
      kind: process.platform === "darwin" ? "launchd" : "systemd",
      ok: false,
      message: "refusing to install service: secret or data dir contains a newline/control character",
    };
  }

  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // non-fatal; the write below will surface a real error if the dir is bad
  }

  if (process.platform === "darwin") {
    const path = plistPath(home);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, macPlist(node, dataDir, secret), "utf8");
      // Lock the plist down: it now carries the secret in plaintext.
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort
      }
      try {
        execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
      } catch {
        // not previously loaded — fine
      }
      execFileSync("launchctl", ["load", "-w", path], { stdio: "ignore" });
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

  if (process.platform === "linux") {
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
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "--now", "memwarden"], {
        stdio: "ignore",
      });
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
    message: `no supported service manager for ${process.platform}`,
  };
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
