//
// A compact Porter stemmer. Porter's algorithm is public-domain; this code
// implements its steps from scratch (plural/past-tense stripping, the step
// 2-4 suffix maps, and final -e / double-l cleanup). The BM25 tokenizer
// and the synonym map both run terms through it, so indexing and querying
// reduce words the same way.

// Porter's step-2 and step-3 suffix replacements (public algorithm tables).
const LONG_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"],
  ["izer", "ize"], ["iser", "ise"], ["abli", "able"], ["alli", "al"],
  ["entli", "ent"], ["eli", "e"], ["ousli", "ous"], ["ization", "ize"],
  ["isation", "ise"], ["ation", "ate"], ["ator", "ate"], ["alism", "al"],
  ["iveness", "ive"], ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"],
  ["iviti", "ive"], ["biliti", "ble"],
];
const DERIVATIONAL: ReadonlyArray<readonly [string, string]> = [
  ["icate", "ic"], ["ative", ""], ["alize", "al"], ["alise", "al"],
  ["iciti", "ic"], ["ical", "ic"], ["ful", ""], ["ness", ""],
];
const STEP4_SUFFIX =
  /(ement|ment|tion|sion|ance|ence|able|ible|ism|ate|iti|ous|ive|ize|ise|ant|ent|al|er|ic|ou)$/;

const hasVowel = (s: string): boolean => /[aeiou]/.test(s);

// Porter's "measure": the count of vowel-then-consonant transitions.
function measure(s: string): number {
  return (s.replace(/[^aeiouy]+/g, "C").replace(/[aeiouy]+/g, "V").match(/VC/g) ?? [])
    .length;
}

function endsDoubledConsonant(s: string): boolean {
  const n = s.length;
  return n >= 2 && s[n - 1] === s[n - 2] && !/[aeiou]/.test(s[n - 1] ?? "");
}

// consonant-vowel-consonant where the final consonant is not w, x, or y.
function endsCvc(s: string): boolean {
  const n = s.length;
  if (n < 3) return false;
  return (
    !/[aeiou]/.test(s[n - 3] ?? "") &&
    /[aeiou]/.test(s[n - 2] ?? "") &&
    !/[aeiouwxy]/.test(s[n - 1] ?? "")
  );
}

// Shared -ed / -ing tail cleanup (Porter step 1b second half).
function restoreShortStem(s: string): string {
  if (s.endsWith("at") || s.endsWith("bl") || s.endsWith("iz")) return s + "e";
  if (endsDoubledConsonant(s) && !/[lsz]$/.test(s)) return s.slice(0, -1);
  if (measure(s) === 1 && endsCvc(s)) return s + "e";
  return s;
}

export function stem(word: string): string {
  if (word.length <= 2) return word;
  let w = word;

  // 1a — plurals
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);

  // 1b — past tense / progressive
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) {
    w = restoreShortStem(w.slice(0, -2));
  } else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) {
    w = restoreShortStem(w.slice(0, -3));
  }

  // 1c — terminal y to i
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";

  // 2 and 3 — suffix maps, applied only when a real stem remains
  for (const [suffix, repl] of LONG_SUFFIXES) {
    if (w.endsWith(suffix)) {
      const base = w.slice(0, -suffix.length);
      if (measure(base) > 0) w = base + repl;
      break;
    }
  }
  for (const [suffix, repl] of DERIVATIONAL) {
    if (w.endsWith(suffix)) {
      const base = w.slice(0, -suffix.length);
      if (measure(base) > 0) w = base + repl;
      break;
    }
  }

  // 4 — strip a residual suffix from a long enough stem
  const m4 = w.match(STEP4_SUFFIX);
  if (m4) {
    const base = w.slice(0, -m4[0].length);
    if (measure(base) > 1) w = base;
  }

  // 5a — drop a trailing e
  if (w.endsWith("e")) {
    const base = w.slice(0, -1);
    if (measure(base) > 1 || (measure(base) === 1 && !endsCvc(base))) w = base;
  }

  // 5b — collapse a doubled l
  if (endsDoubledConsonant(w) && w.endsWith("l") && measure(w.slice(0, -1)) > 1) {
    w = w.slice(0, -1);
  }

  return w;
}
