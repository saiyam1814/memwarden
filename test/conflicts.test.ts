//
// detectConflicts — the advisory contradiction report used by mem::doctor.
// These tests pin the TIGHTENED contract: reworded facts, abbreviations, and
// different attributes of one subject must NOT trip, while genuine
// contradictions (value flip on a single-valued subject, polarity flip) still
// do. detectConflicts is exercised directly over CompressedObservation
// fixtures so the heuristic is unit-tested without the kernel.

import { describe, expect, it } from "vitest";
import { detectConflicts } from "../src/functions/conflicts.js";
import type { CompressedObservation } from "../src/functions/types.js";

let seq = 0;
function obs(narrative: string, when: string): CompressedObservation {
  seq++;
  return {
    id: `obs-${seq}`,
    sessionId: "s1",
    timestamp: when,
    type: "other",
    title: `mem ${seq}`,
    facts: [],
    narrative,
    concepts: [],
    files: [],
    importance: 5,
  };
}

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";

describe("detectConflicts — NO false positives", () => {
  it("does NOT flag an abbreviation/acronym rewording (JWTs vs JSON web tokens)", () => {
    const c = detectConflicts([
      obs("auth uses JWTs", T1),
      obs("auth uses JSON web tokens", T2),
    ]);
    expect(c).toEqual([]);
  });

  it("does NOT flag two different libraries on a generic container subject (uses zod vs uses vitest)", () => {
    const c = detectConflicts([
      obs("the project uses zod for validation", T1),
      obs("the project uses vitest for tests", T2),
    ]);
    expect(c).toEqual([]);
  });

  it("does NOT flag different attributes of one subject (runs on port 3111 vs runs on localhost only)", () => {
    const c = detectConflicts([
      obs("the server runs on port 3111", T1),
      obs("the server runs on localhost only", T2),
    ]);
    expect(c).toEqual([]);
  });

  it("does NOT let a subordinate-clause negation flip an unrelated claim's polarity", () => {
    // The "not" sits in a subordinate clause about something else; it must not
    // turn "auth uses bearer tokens" into a negative claim that then "conflicts"
    // with the plain positive one.
    const c = detectConflicts([
      obs("auth uses bearer tokens", T1),
      obs("auth uses bearer tokens, which are not deprecated", T2),
    ]);
    expect(c).toEqual([]);
  });

  it("does NOT flag the exact same fact captured twice", () => {
    const c = detectConflicts([
      obs("auth uses bearer tokens", T1),
      obs("auth uses bearer tokens", T2),
    ]);
    expect(c).toEqual([]);
  });
});

describe("detectConflicts — genuine contradictions still flagged", () => {
  it("flags a value conflict on a single-valued subject (bearer tokens vs session cookies)", () => {
    const c = detectConflicts([
      obs("auth uses bearer tokens", T1),
      obs("auth uses session cookies", T2),
    ]);
    expect(c.length).toBe(1);
    expect(c[0]!.subject).toBe("auth");
  });

  it("flags a value conflict that shares a qualifier (bcrypt for passwords vs MD5 for passwords)", () => {
    const c = detectConflicts([
      obs("the app uses bcrypt for passwords", T1),
      obs("the app uses MD5 for passwords", T2),
    ]);
    expect(c.length).toBe(1);
    expect(c[0]!.reason).toMatch(/incompatible values/);
  });

  it("flags a polarity conflict (cache is enabled vs cache is disabled)", () => {
    const c = detectConflicts([
      obs("cache is enabled", T1),
      obs("cache is disabled", T2),
    ]);
    expect(c.length).toBe(1);
    expect(c[0]!.reason).toMatch(/changed polarity/);
  });

  it("flags an explicit negation of the same fact (uses X vs does not use X)", () => {
    const c = detectConflicts([
      obs("auth uses bearer tokens", T1),
      obs("auth does not use bearer tokens", T2),
    ]);
    expect(c.length).toBe(1);
    expect(c[0]!.reason).toMatch(/changed polarity/);
  });
});
