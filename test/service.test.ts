//
// installService must refuse to write a service unit when the secret or data
// dir carries a newline/CR/NUL — those are directive-injection vectors in the
// generated launchd plist / systemd unit (e.g. a chosen --secret could append
// a rogue ExecStartPre). The guard returns before any filesystem write, so
// this test touches nothing on disk.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __installServiceForTests,
  __macPlistForTests,
  __systemdUnitForTests,
  __tuningEnvForTests,
  installService,
} from "../src/daemon/service.js";
import {
  DAEMON_LOG_FILENAME,
  DAEMON_LOG_MODE_ENV,
  DAEMON_LOG_MODE_FILE,
  DAEMON_LOG_MODE_JOURNALD,
} from "../src/daemon/log.js";

const roots: string[] = [];
const posixIt = process.platform === "win32" ? it.skip : it;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memwarden-service-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("installService injection guard", () => {
  it("refuses a secret containing a newline (would inject a unit directive)", () => {
    const r = installService("/tmp/mw-test-dir", "abc\nExecStartPre=/usr/bin/touch /tmp/pwned");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/newline|control character/i);
  });

  it("refuses a data dir containing a carriage return", () => {
    const r = installService("/tmp/mw\rtest", "safe-secret");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/newline|control character/i);
  });

  // Production happy paths are never called by this suite. The tests below use
  // an injected platform, command runner, and HOME rooted entirely in /tmp.
});

describe("temp-only managed service installation", () => {
  posixIt("prepares a 0600 regular launchd log before load and emits the fixed path", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const dataDir = join(root, "brain");
    const log = join(dataDir, DAEMON_LOG_FILENAME);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(log, "existing launchd output");
    chmodSync(log, 0o644);
    const calls: Array<{ command: string; args: string[] }> = [];

    const result = __installServiceForTests(dataDir, "safe-secret", {
      platform: "darwin",
      home,
      node: "/tmp/node & runtime",
      run: (command, args) => {
        calls.push({ command, args: [...args] });
        if (args[0] !== "load") return;
        expect(lstatSync(log).isFile()).toBe(true);
        expect(statSync(log).mode & 0o777).toBe(0o600);
        const plistPath = args.at(-1)!;
        const plist = readFileSync(plistPath, "utf8");
        expect(plist).toContain(`<key>${DAEMON_LOG_MODE_ENV}</key><string>${DAEMON_LOG_MODE_FILE}</string>`);
        expect(plist).toContain(`<key>StandardOutPath</key><string>${log}</string>`);
        expect(plist).toContain(`<key>StandardErrorPath</key><string>${log}</string>`);
        expect(plist).toContain("/tmp/node &amp; runtime");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("launchd");
    expect(result.path).toBe(join(home, "Library", "LaunchAgents", "ai.memwarden.daemon.plist"));
    expect(calls.map(({ command, args }) => `${command} ${args[0]}`)).toEqual([
      "launchctl unload",
      "launchctl load",
    ]);
    expect(statSync(result.path!).mode & 0o777).toBe(0o600);
  });

  posixIt("fails launchd installation closed on a symlink without loading or touching its target", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const dataDir = join(root, "brain");
    const outside = join(root, "outside.log");
    const sentinel = "SERVICE-TARGET-CONTENT";
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(outside, sentinel);
    symlinkSync(outside, join(dataDir, DAEMON_LOG_FILENAME));
    let commandCount = 0;

    const result = __installServiceForTests(dataDir, "safe-secret", {
      platform: "darwin",
      home,
      run: () => {
        commandCount++;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refusing unsafe daemon log/i);
    expect(result.message).not.toContain(sentinel);
    expect(commandCount).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe(sentinel);
    expect(lstatSync(join(dataDir, DAEMON_LOG_FILENAME)).isSymbolicLink()).toBe(true);
    expect(
      existsSync(join(home, "Library", "LaunchAgents", "ai.memwarden.daemon.plist")),
    ).toBe(false);
  });

  it("keeps systemd on journald and does not create a daemon log", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const dataDir = join(root, "brain");
    const commands: string[] = [];

    const result = __installServiceForTests(dataDir, "safe-secret", {
      platform: "linux",
      home,
      run: (command, args) => commands.push(`${command} ${args.join(" ")}`),
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(dataDir, DAEMON_LOG_FILENAME))).toBe(false);
    const unit = readFileSync(result.path!, "utf8");
    expect(unit).toContain(`Environment=${DAEMON_LOG_MODE_ENV}=${DAEMON_LOG_MODE_JOURNALD}`);
    expect(unit).not.toContain("StandardOutPath");
    expect(commands).toHaveLength(2);
  });

  it("generates explicit file/journald modes without filesystem access", () => {
    const dataDir = join(tempRoot(), "not-created");
    const plist = __macPlistForTests("/node", dataDir);
    const unit = __systemdUnitForTests("/node", dataDir);
    expect(plist).toContain(`<key>${DAEMON_LOG_MODE_ENV}</key><string>${DAEMON_LOG_MODE_FILE}</string>`);
    expect(plist).toContain(join(dataDir, DAEMON_LOG_FILENAME));
    expect(unit).toContain(`Environment=${DAEMON_LOG_MODE_ENV}=${DAEMON_LOG_MODE_JOURNALD}`);
    expect(existsSync(dataDir)).toBe(false);
  });
});

describe("service tuning-env passthrough", () => {
  it("forwards safe MEMWARDEN tuning vars and rejects unit-breaking values", () => {
    process.env.MEMWARDEN_VECTOR_BACKEND = "turbovec";
    process.env.MEMWARDEN_EMBED_DTYPE = "q8";
    process.env.MEMWARDEN_QUANT_SEED = "evil\nExecStartPre=/usr/bin/touch"; // newline -> rejected
    try {
      const entries = Object.fromEntries(__tuningEnvForTests());
      expect(entries["MEMWARDEN_VECTOR_BACKEND"]).toBe("turbovec");
      expect(entries["MEMWARDEN_EMBED_DTYPE"]).toBe("q8");
      expect(entries["MEMWARDEN_QUANT_SEED"]).toBeUndefined();
      expect(entries["MEMWARDEN_SECRET"]).toBeUndefined(); // secret has its own path
    } finally {
      delete process.env.MEMWARDEN_VECTOR_BACKEND;
      delete process.env.MEMWARDEN_EMBED_DTYPE;
      delete process.env.MEMWARDEN_QUANT_SEED;
    }
  });

  // `up --lexical-only` used to only skip the transformers.js INSTALL. That is
  // a no-op the moment the model is cached: the daemon decides on AVAILABILITY,
  // not intent (index.ts asks LocalEmbeddingProvider.isAvailable()), so after
  // any earlier plain `up` the flag silently did nothing and the daemon loaded
  // the model anyway (~93MB, measured). The flag now sets
  // MEMWARDEN_EMBEDDING_PROVIDER=none, which createEmbeddingProvider honours —
  // and this passthrough is what carries that choice into the installed
  // service so it survives restarts. If this row ever stops forwarding the
  // provider, --lexical-only silently regresses to a no-op again.
  it("forwards MEMWARDEN_EMBEDDING_PROVIDER=none — what makes --lexical-only real", () => {
    process.env.MEMWARDEN_EMBEDDING_PROVIDER = "none";
    try {
      const entries = Object.fromEntries(__tuningEnvForTests());
      expect(entries["MEMWARDEN_EMBEDDING_PROVIDER"]).toBe("none");
    } finally {
      delete process.env.MEMWARDEN_EMBEDDING_PROVIDER;
    }
  });
});
