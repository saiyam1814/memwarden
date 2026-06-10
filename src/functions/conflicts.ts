import type { CompressedObservation } from "./types.js";

export interface MemoryConflict {
  olderId: string;
  olderTitle: string;
  newerId: string;
  newerTitle: string;
  subject: string;
  olderClaim: string;
  newerClaim: string;
  reason: string;
}

interface Claim {
  subject: string;
  relation: string;
  value: string;
  /** Significant tokens of the value, used for same-attribute detection. */
  valueTokens: string[];
  polarity: "positive" | "negative";
  text: string;
  obs: CompressedObservation;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with",
]);

// Tokens that negate the claim they sit in. Clause-local: a negation only
// flips polarity when it appears in the SAME clause as the matched
// subject/relation (see extractClaims), so a subordinate "…which is not
// deprecated" can't flip the polarity of the main claim.
const NEGATION_RE = /\b(no longer|not|never|without|doesn't|does not|do not|isn't|is not|aren't|are not|disabled)\b/i;

// Generic "container" subjects that legitimately hold many independent facts
// ("the project uses zod" AND "the project uses vitest" are both true). For
// these, two different positive values are NOT treated as a contradiction
// unless they share a qualifier (the same attribute, e.g. "…for passwords").
// A SPECIFIC subject (auth, cache, runtime, …) is single-valued, so two
// different values for it DO contradict.
const CONTAINER_SUBJECTS = new Set([
  "project",
  "repo",
  "repository",
  "codebase",
  "code base",
  "app",
  "application",
  "system",
  "service",
  "server",
  "stack",
  "we",
  "they",
  "it",
]);

const CLAIM_PATTERNS: ReadonlyArray<{
  relation: string;
  re: RegExp;
}> = [
  {
    relation: "uses",
    re: /\b(.{2,80}?)\b(?:does not use|doesn't use|do not use|no longer uses|no longer use|never uses|never use|uses|use)\b\s+(.{2,100})/i,
  },
  {
    relation: "is",
    re: /\b(.{2,80}?)\b(?:is not|isn't|are not|aren't|is|are|was|were|becomes|became)\b\s+(.{2,100})/i,
  },
  {
    relation: "configured",
    re: /\b(.{2,80}?)\b(?:defaults to|default is|configured to|set to|runs on|stores in|writes to)\b\s+(.{2,100})/i,
  },
];

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/["'`{}[\](),;:]/g, " ")
    .replace(/[_/\\|=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(raw: string): string[] {
  return normalize(raw)
    .split(" ")
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function subjectKey(raw: string): string {
  const ws = words(raw);
  return ws.slice(-5).join(" ");
}

function valueWords(raw: string): string[] {
  const firstClause = raw.split(/[.!?\n|]/)[0] ?? raw;
  return words(firstClause)
    .filter((w) => !["now", "currently", "instead", "rather", "than"].includes(w))
    .slice(0, 8);
}

function valueKey(raw: string): string {
  return valueWords(raw).join(" ");
}

// Split into clauses so negation can be scoped clause-locally. Clause
// boundaries are sentence terminators AND coordinating/subordinating breaks
// (commas, "which", "but", "although", "while", "however") so that a "not"
// living in a subordinate clause does not reach the main claim's clause.
function clausesOf(sentence: string): string[] {
  return sentence
    .split(/,|\bwhich\b|\bwho\b|\bwhere\b|\bbut\b|\balthough\b|\bwhile\b|\bhowever\b|\bwhereas\b|\bthough\b/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function splitClaimsText(obs: CompressedObservation): string[] {
  const text = [obs.title, obs.subtitle, ...obs.facts, obs.narrative]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join(" | ");
  return text
    .split(/[.!?\n|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 240);
}

function extractClaims(obs: CompressedObservation): Claim[] {
  const claims: Claim[] = [];
  for (const sentence of splitClaimsText(obs)) {
    for (const pattern of CLAIM_PATTERNS) {
      const match = pattern.re.exec(sentence);
      if (!match) continue;
      const subject = subjectKey(match[1] ?? "");
      const value = valueKey(match[2] ?? "");
      if (!subject || !value) continue;
      // Clause-local negation: only the clause that actually contains the
      // matched subject+value can flip polarity. A "not"/"never"/"disabled"
      // anywhere else in the sentence (e.g. a subordinate clause) is ignored.
      const matchedText = normalize(match[0] ?? sentence);
      const owningClause =
        clausesOf(sentence).find((c) => {
          const n = normalize(c);
          return n.length > 0 && (matchedText.includes(n) || n.includes(value));
        }) ?? sentence;
      claims.push({
        subject,
        relation: pattern.relation,
        value,
        valueTokens: valueWords(match[2] ?? ""),
        polarity: NEGATION_RE.test(owningClause) ? "negative" : "positive",
        text: normalize(sentence),
        obs,
      });
      break;
    }
  }
  return claims;
}

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared++;
  return shared / (left.size + right.size - shared);
}

// True when the two phrases are an abbreviation/acronym pair, e.g.
// "jwts" <-> "json web tokens", "k8s"-style initialisms aside. We compare the
// initials of the multi-word phrase against the (de-pluralized) short token.
function acronymMatch(a: string[], b: string[]): boolean {
  const tryPair = (acr: string[], phrase: string[]): boolean => {
    if (acr.length !== 1 || phrase.length < 2) return false;
    const token = acr[0]!.replace(/s$/, "");
    if (token.length < 2) return false;
    const initials = phrase.map((w) => w[0] ?? "").join("");
    return token === initials;
  };
  return tryPair(a, b) || tryPair(b, a);
}

// "Same fact, reworded" — the two values are NOT in genuine value-conflict.
// Equal, one contains the other, an acronym/abbreviation pair, or high
// token-overlap (>= 0.5) all count as the same fact.
function valuesCompatible(a: Claim, b: Claim): boolean {
  if (a.value === b.value) return true;
  if (a.value.includes(b.value) || b.value.includes(a.value)) return true;
  if (acronymMatch(a.valueTokens, b.valueTokens)) return true;
  return jaccard(a.valueTokens, b.valueTokens) >= 0.5;
}

// On/off state words that carry the polarity themselves rather than naming a
// distinct value: "cache is enabled" vs "cache is disabled" is the SAME
// attribute toggled, not two different values. Stripped before the
// polarity-conflict comparison so the residual values line up.
const STATE_WORDS = new Set([
  "enabled",
  "disabled",
  "on",
  "off",
  "active",
  "inactive",
  "present",
  "absent",
]);

function stripStateTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !STATE_WORDS.has(t));
}

// Are the two claims about the SAME thing such that opposite polarity is a
// real contradiction? True when the residual values (state words removed)
// line up — including the common "enabled"/"disabled" case where both reduce
// to nothing and the subject IS the toggled thing.
function samePolarityTarget(a: Claim, b: Claim): boolean {
  if (valuesCompatible(a, b)) return true;
  const ra = stripStateTokens(a.valueTokens);
  const rb = stripStateTokens(b.valueTokens);
  if (ra.length === 0 && rb.length === 0) return true; // pure state toggle
  if (ra.length === 0 || rb.length === 0) {
    // One side is a pure state word ("disabled"); the other carries the same
    // residual the toggle applies to.
    return jaccard(ra, rb) > 0 || ra.join(" ") === rb.join(" ");
  }
  return jaccard(ra, rb) >= 0.5;
}

// Do the two values share a qualifier token (the same attribute)? e.g.
// "bcrypt for passwords" vs "md5 for passwords" share "passwords". Used to
// turn a generic-container subject's differing values into a real conflict.
function shareQualifier(a: Claim, b: Claim): boolean {
  const right = new Set(b.valueTokens);
  return a.valueTokens.some((t) => right.has(t));
}

function isContainerSubject(subject: string): boolean {
  if (CONTAINER_SUBJECTS.has(subject)) return true;
  // Multi-word subjects ending in a container head ("the api server") still
  // count as a container.
  const last = subject.split(" ").pop() ?? subject;
  return CONTAINER_SUBJECTS.has(last);
}

function compareByTime(a: CompressedObservation, b: CompressedObservation): number {
  const left = Date.parse(a.timestamp);
  const right = Date.parse(b.timestamp);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
    return left - right;
  }
  return a.id.localeCompare(b.id);
}

function conflictBetween(a: Claim, b: Claim): MemoryConflict | null {
  if (a.obs.id === b.obs.id) return null;
  if (a.subject !== b.subject || a.relation !== b.relation) return null;

  const compatible = valuesCompatible(a, b);

  // Polarity conflict: the SAME thing asserted both ways (positive vs negative)
  // — e.g. "cache is enabled" vs "cache is disabled", or "uses X" vs "does not
  // use X". State words ("enabled"/"disabled") carry the polarity themselves,
  // so we compare the residual target rather than the raw value strings.
  const polarityConflict =
    a.polarity !== b.polarity && samePolarityTarget(a, b);

  // Value conflict: two POSITIVE claims with genuinely different values for the
  // same subject+relation. Only a real contradiction when:
  //   - the values aren't the same fact reworded (compatible == false), AND
  //   - they aren't two different attributes of one subject. For the
  //     "configured" relation (runs on / set to / defaults to …) values with
  //     no shared token are different attributes (port vs host), not a clash.
  //   - for a generic CONTAINER subject (project/repo/app/…) two unrelated
  //     values are independent facts unless they share a qualifier (the same
  //     attribute). A SPECIFIC subject is single-valued, so any differing
  //     value contradicts.
  let valueConflict = false;
  if (!compatible && a.polarity === "positive" && b.polarity === "positive") {
    const shared = shareQualifier(a, b);
    if (a.relation === "configured" && !shared) {
      valueConflict = false; // different attributes of the same subject
    } else if (isContainerSubject(a.subject) && !shared) {
      valueConflict = false; // independent facts about a container
    } else {
      valueConflict = true;
    }
  }

  if (!polarityConflict && !valueConflict) return null;

  const [older, newer] = compareByTime(a.obs, b.obs) <= 0 ? [a, b] : [b, a];
  return {
    olderId: older.obs.id,
    olderTitle: older.obs.title,
    newerId: newer.obs.id,
    newerTitle: newer.obs.title,
    subject: older.subject,
    olderClaim: older.text,
    newerClaim: newer.text,
    reason: polarityConflict
      ? `same subject "${older.subject}" changed polarity`
      : `same subject "${older.subject}" has incompatible values`,
  };
}

/**
 * Advisory contradiction report for mem::doctor. Deliberately conservative:
 * simple subject/relation/value claims, clause-local negation, and a high bar
 * for value conflicts so reworded facts, abbreviations, and different
 * attributes of one subject don't fire. NEVER used to drop memory from recall
 * — recall only firewalls STALE memory.
 */
export function detectConflicts(
  observations: CompressedObservation[],
  limit = 20,
): MemoryConflict[] {
  const groups = new Map<string, Claim[]>();
  for (const obs of observations) {
    for (const claim of extractClaims(obs)) {
      const key = `${claim.relation}:${claim.subject}`;
      const group = groups.get(key);
      if (group) group.push(claim);
      else groups.set(key, [claim]);
    }
  }

  const conflicts: MemoryConflict[] = [];
  const seen = new Set<string>();
  for (const group of groups.values()) {
    const sorted = group.sort((a, b) => compareByTime(a.obs, b.obs));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const conflict = conflictBetween(sorted[i]!, sorted[j]!);
        if (!conflict) continue;
        const key = `${conflict.olderId}:${conflict.newerId}:${conflict.subject}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push(conflict);
        if (conflicts.length >= limit) return conflicts;
      }
    }
  }
  return conflicts;
}
