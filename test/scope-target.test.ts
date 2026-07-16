//
// MEMWARDEN_URL / MEMWARDEN_REST_PORT scope the DAEMON. They do NOT scope the
// service or the tool configs, which are user-global — and the wiring bakes
// this run's URL and secret into them. So before this guard, `up` against a
// throwaway daemon reached out and repointed the user's REAL tools at it, and
// `down` unloaded the real service as a side effect of tidying up.
//
// Observed four times in one session while running "isolated" experiments:
// `up` with MEMWARDEN_URL=http://localhost:3198 repointed five real tool
// configs at a temp daemon that was then deleted; `down --data` with a temp
// MEMWARDEN_DATA_DIR correctly deleted only the temp brain but still unloaded
// the real launchd service. The failure is SILENT: hooks embed no URL and keep
// hitting :3111, so `status` still reports a live host while every MCP entry
// points at a dead port. A warning was tried first and was not enough — the
// configs were clobbered while the warning printed. Hence: refuse by default,
// `--wire` to opt in.
//
// Keyed on URL/PORT only, deliberately NOT on MEMWARDEN_DATA_DIR: a relocated
// brain on the default port is a legitimate permanent install whose tools
// SHOULD still be wired to :3111. Blocking that would break those users. The
// harm comes exclusively from baking a non-default ADDRESS into global config.
//
import { describe, expect, it } from "vitest";
import { targetsDefaultDaemon } from "../src/cli/bin.js";

describe("targetsDefaultDaemon — may this run touch user-global state?", () => {
  it("a clean env targets the default daemon", () => {
    expect(targetsDefaultDaemon({})).toBe(true);
  });

  it("vars set to the DEFAULT values still target the default daemon", () => {
    expect(
      targetsDefaultDaemon({
        MEMWARDEN_URL: "http://localhost:3111",
        MEMWARDEN_REST_PORT: "3111",
      }),
    ).toBe(true);
  });

  it("empty/whitespace vars are treated as unset, not as overrides", () => {
    expect(targetsDefaultDaemon({ MEMWARDEN_URL: "", MEMWARDEN_REST_PORT: "  " })).toBe(true);
  });

  // The exact shape of the real incident.
  it("THE INCIDENT: a throwaway daemon on :3198 does NOT target the default", () => {
    expect(
      targetsDefaultDaemon({
        MEMWARDEN_URL: "http://localhost:3198",
        MEMWARDEN_REST_PORT: "3198",
        MEMWARDEN_DATA_DIR: "/tmp/mw-test-brain",
      }),
    ).toBe(false);
  });

  it("a non-default URL alone is enough to scope the run", () => {
    expect(targetsDefaultDaemon({ MEMWARDEN_URL: "http://localhost:3199" })).toBe(false);
  });

  it("a non-default PORT alone is enough to scope the run", () => {
    expect(targetsDefaultDaemon({ MEMWARDEN_REST_PORT: "3199" })).toBe(false);
  });

  it("a remote daemon does not target the local default either", () => {
    expect(targetsDefaultDaemon({ MEMWARDEN_URL: "http://10.0.0.5:3111" })).toBe(false);
  });

  // The deliberate non-guard. A relocated brain is a real, permanent install:
  // its daemon still listens on :3111, so its tools still belong wired to
  // :3111. Scoping on dataDir would silently stop wiring for those users.
  it("a RELOCATED BRAIN on the default port still targets the default daemon", () => {
    expect(targetsDefaultDaemon({ MEMWARDEN_DATA_DIR: "/opt/memwarden-brain" })).toBe(true);
  });

  it("...but a relocated brain on a custom port does not", () => {
    expect(
      targetsDefaultDaemon({
        MEMWARDEN_DATA_DIR: "/opt/memwarden-brain",
        MEMWARDEN_REST_PORT: "4000",
      }),
    ).toBe(false);
  });
});
