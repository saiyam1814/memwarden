//
// installService must refuse to write a service unit when the secret or data
// dir carries a newline/CR/NUL — those are directive-injection vectors in the
// generated launchd plist / systemd unit (e.g. a chosen --secret could append
// a rogue ExecStartPre). The guard returns before any filesystem write, so
// this test touches nothing on disk.

import { describe, expect, it } from "vitest";
import { installService, __tuningEnvForTests } from "../src/daemon/service.js";

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

  // We do NOT assert the happy path here: a real install writes to the user's
  // LaunchAgents / systemd dir and runs launchctl/systemctl. Spaces-in-paths
  // are allowed by the guard (verified by the regex), so legitimate macOS home
  // dirs like "/Users/My Name/.memwarden" are not rejected.
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
});
