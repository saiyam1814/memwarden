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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function macPlist(node: string, dataDir: string): string {
  const log = join(dataDir, "daemon.log");
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
    <key>MEMWARDEN_DATA_DIR</key><string>${dataDir}</string>
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

function systemdUnit(node: string, dataDir: string): string {
  return `[Unit]
Description=memwarden memory daemon
After=network.target

[Service]
ExecStart=${node} ${DAEMON_ENTRY}
Environment=MEMWARDEN_DATA_DIR=${dataDir}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** Install + start the supervised daemon for this platform. Best-effort. */
export function installService(dataDir: string): ServiceResult {
  const home = homedir();
  const node = process.execPath;
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // non-fatal; the write below will surface a real error if the dir is bad
  }

  if (process.platform === "darwin") {
    const path = plistPath(home);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, macPlist(node, dataDir), "utf8");
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
      writeFileSync(path, systemdUnit(node, dataDir), "utf8");
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
