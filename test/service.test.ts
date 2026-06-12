//
// installService must refuse to write a service unit when the secret or data
// dir carries a newline/CR/NUL — those are directive-injection vectors in the
// generated launchd plist / systemd unit (e.g. a chosen --secret could append
// a rogue ExecStartPre). The guard returns before any filesystem write, so
// this test touches nothing on disk.

import { describe, expect, it } from "vitest";
import { installService } from "../src/daemon/service.js";

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
