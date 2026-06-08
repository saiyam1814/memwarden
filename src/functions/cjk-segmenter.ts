//
// CJK-aware segmentation for the BM25 tokenizer. CJK text has no spaces, so a
// run of Han/Kana/Hangul is segmented before tokenizing. Chinese and Japanese
// use optional native segmenters (@node-rs/jieba, tiny-segmenter) loaded
// lazily via createRequire; when they are absent the run is kept whole (search
// still works, just coarser) so there are no required new dependencies. Korean
// is split into Hangul blocks with a plain regex (no dependency).

import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

const ANY_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const HANGUL_BLOCK = /[가-힯]+/g;

type Script = "han" | "kana" | "hangul" | "other";

export function hasCjk(text: string): boolean {
  return ANY_CJK.test(text);
}

export function detectScript(text: string): Script {
  if (HAN.test(text)) return "han";
  if (KANA.test(text)) return "kana";
  if (HANGUL.test(text)) return "hangul";
  return "other";
}

const hinted = new Set<string>();
function hintOnce(key: string, message: string): void {
  if (hinted.has(key)) return;
  hinted.add(key);
  process?.stderr?.write?.(`memwarden: ${message}\n`);
}

// Generic lazy loader for an optional segmenter: returns a cut(text)->tokens
// function, or null (memoized) if the package is not installed.
type Cut = (text: string) => string[];
const loaded = new Map<string, Cut | null>();

function loadJieba(): Cut | null {
  if (loaded.has("jieba")) return loaded.get("jieba") ?? null;
  let cut: Cut | null = null;
  try {
    const mod = req("@node-rs/jieba") as {
      Jieba: { new (): { cut(t: string, hmm?: boolean): string[] }; withDict(d: Uint8Array): { cut(t: string, hmm?: boolean): string[] } };
    };
    let inst: { cut(t: string, hmm?: boolean): string[] };
    try {
      inst = mod.Jieba.withDict((req("@node-rs/jieba/dict") as { dict: Uint8Array }).dict);
    } catch {
      inst = new mod.Jieba();
    }
    cut = (t) => inst.cut(t, true);
  } catch {
    hintOnce("jieba", "install @node-rs/jieba to improve Chinese search; using whole-string tokens for now");
  }
  loaded.set("jieba", cut);
  return cut;
}

function loadJa(): Cut | null {
  if (loaded.has("ja")) return loaded.get("ja") ?? null;
  let cut: Cut | null = null;
  try {
    const Ctor = req("tiny-segmenter") as new () => { segment(t: string): string[] };
    const inst = new Ctor();
    cut = (t) => inst.segment(t);
  } catch {
    hintOnce("tiny-segmenter", "install tiny-segmenter to improve Japanese search; using whole-string tokens for now");
  }
  loaded.set("ja", cut);
  return cut;
}

function nonEmpty(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const v = t.trim();
    if (v) out.push(v);
  }
  return out;
}

function segmentRun(run: string): string[] {
  if (HANGUL.test(run)) {
    return [...run.matchAll(HANGUL_BLOCK)].map((m) => m[0]);
  }
  const cut = KANA.test(run) ? loadJa() : loadJieba();
  if (!cut) return [run];
  try {
    return nonEmpty(cut(run));
  } catch {
    return [run];
  }
}

export function segmentCjk(text: string): string[] {
  if (!hasCjk(text)) return [text];
  const out: string[] = [];
  let at = 0;
  for (const m of text.matchAll(CJK_RUN)) {
    const start = m.index ?? 0;
    if (start > at) {
      const gap = text.slice(at, start).trim();
      if (gap) out.push(gap);
    }
    out.push(...segmentRun(m[0]));
    at = start + m[0].length;
  }
  if (at < text.length) {
    const tail = text.slice(at).trim();
    if (tail) out.push(tail);
  }
  return out;
}

export function __resetCjkSegmenterStateForTests(): void {
  hinted.clear();
  loaded.clear();
}
