//
// Zero-LLM compression: turn a RawObservation into a CompressedObservation
// with heuristics only (no model call, no token spend). This is the default
// observe path until an LLM provider is wired in. It classifies the tool,
// pulls out any file paths, and builds a short narrative.

import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
} from "./types.js";

// tool-name keyword -> observation type, in priority order
const TOOL_KINDS: ReadonlyArray<readonly [ObservationType, readonly string[]]> = [
  ["web_fetch", ["fetch", "http", "web"]],
  ["search", ["grep", "search", "glob", "find"]],
  ["command_run", ["bash", "shell", "exec", "run"]],
  ["file_edit", ["edit", "update", "patch", "replace"]],
  ["file_write", ["write", "create"]],
  ["file_read", ["read", "view"]],
  ["subagent", ["task", "agent"]],
];

const FILE_KEYS = ["file_path", "filepath", "path", "filePath", "file", "pattern"];

// split camelCase / kebab / spaces into a normalized underscore form
function normalizeToolName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function mentions(normalized: string, word: string): boolean {
  return (
    new RegExp(`(^|_)${word}(_|$)`).test(normalized) ||
    normalized === word ||
    normalized.startsWith(word) ||
    normalized.endsWith(word)
  );
}

function classify(toolName: string | undefined, hookType: string): ObservationType {
  if (hookType === "post_tool_failure") return "error";
  if (hookType === "prompt_submit" || hookType === "user_prompt") return "conversation";
  if (hookType === "subagent_stop" || hookType === "task_completed") return "subagent";
  if (hookType === "notification") return "notification";
  if (!toolName) return "other";
  const n = normalizeToolName(toolName);
  for (const [kind, words] of TOOL_KINDS) {
    if (words.some((w) => mentions(n, w))) return kind;
  }
  return "other";
}

function filePaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const found = new Set<string>();
  for (const key of FILE_KEYS) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0 && v.length < 512) found.add(v);
  }
  return [...found];
}

function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// --- extraction ------------------------------------------------------
//
// The old version titled every memory with the TOOL NAME and stored the raw
// tool-input JSON as the narrative, with `facts` and `concepts` always empty.
// Measured on a real six-week install, that produced memories like:
//
//   title: "Write"
//   body : {"file_path":"/Users/…/email-to-preet.txt","content":"Subject: Re: …
//
// which is a log line wearing a memory's clothes: unrankable (every title is
// one of six words), unreadable, and invisible to lexical search because the
// only searchable terms were JSON keys. Provenance and hashing worked
// perfectly and were verifying junk.
//
// Everything below exists to answer "what happened?" instead of "what ran?",
// with no model call — the zero-LLM promise is kept.

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

/** Last path segment, so titles read "auth.ts" rather than a 90-char path. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** One line, no runaway whitespace — titles and narratives must stay scannable. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The first line of a shell command, minus noise, so a title reads
 * "npm test" rather than a 200-char pipeline.
 */
function commandSummary(cmd: string): string {
  const first = oneLine(cmd.split("\n").find((l) => l.trim())?.trim() ?? cmd);
  // Heredocs and long pipelines carry no title value past the first clause.
  const clause = first.split(/\s*(?:\|\||&&|\||;|<<)\s*/)[0] ?? first;
  return clip(oneLine(clause), 70);
}

/**
 * Identifiers worth searching for: path segments, file stems, and code-shaped
 * symbols. These populate `concepts`, which is what hybrid search actually
 * matches on — leaving it empty made lexical recall a coin flip.
 */
// Structural directory names carry no topical signal. Without this, every
// record picks up "src"/"repo"/"users" and looks like it has real concepts —
// which also defeats the barren check below, so a contentless read gets treated
// as knowledge worth keeping forever.
const PATH_STOPWORDS = new Set([
  "src", "lib", "test", "tests", "spec", "dist", "build", "out", "bin", "app",
  "apps", "pkg", "pkgs", "packages", "repo", "repos", "home", "users", "user",
  "tmp", "temp", "var", "opt", "etc", "private", "documents", "downloads",
  "desktop", "node_modules", "vendor", "target", "index", "main", "internal",
  "common", "shared", "utils", "util", "helpers", "core", "git", "github",
]);

function conceptsFrom(paths: string[], text: string): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    // A search pattern arrives via the same key set as file paths, so a regex
    // or glob would otherwise be mined as if it were a directory name.
    if (/[*?|{}()\[\]]/.test(p)) continue;
    // The segment right after a home-directory root is the OS username. It is
    // personal data, it is identical across every memory on the machine, and it
    // has zero retrieval value — observed polluting every concept list with the
    // owner's name.
    const homeUser = /(?:^|\/)(?:Users|home)\/([^/\\]+)/.exec(p)?.[1];
    const base = baseName(p);
    const stem = base.replace(/\.[a-z0-9]+$/i, "");
    if (stem.length > 2 && !PATH_STOPWORDS.has(stem.toLowerCase())) out.add(stem);
    for (const seg of p.split(/[\\/]/)) {
      // Directory names are strong topical signals ("auth", "triggers") —
      // but only the ones that name a domain, not a layout convention.
      if (
        /^[a-z][a-z0-9_-]{2,20}$/i.test(seg) &&
        seg !== base &&
        seg !== homeUser &&
        !PATH_STOPWORDS.has(seg.toLowerCase())
      ) {
        out.add(seg);
      }
    }
  }
  // Escape sequences in JSON-encoded tool output fuse into the identifier that
  // follows them: "\tisPremium" was being mined as the symbol "tisPremium", and
  // "\nTHE" as "nTHE". Neutralize them before matching.
  const scrubbed = oneLine(text).replace(/\\[tnrfv0]/g, " ");

  // Code-shaped symbols. CONSTANT_CASE deliberately requires an underscore or a
  // digit: without that, ordinary shouty English ("THE", "PASS", "GATE") from
  // logs and comments floods the concept list and buries the real identifiers.
  const symbols =
    scrubbed.match(
      /\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}|[A-Z]+\d[A-Z0-9_]*|[a-z]+[A-Z][A-Za-z0-9]{2,}|[A-Z][a-z]+[A-Z][A-Za-z0-9]+)\b/g,
    ) ?? [];
  for (const s of symbols.slice(0, 24)) out.add(s);
  return [...out].slice(0, 16);
}

/** Concrete, quotable assertions — the difference between a record and a fact. */
function factsFrom(args: {
  toolName: string;
  input: Record<string, unknown>;
  outputText: string;
  isFailure: boolean;
}): string[] {
  const facts: string[] = [];
  const oldS = str(args.input, "old_string");
  const newS = str(args.input, "new_string");
  if (oldS && newS) {
    // The actual change, which is the whole point of remembering an edit.
    facts.push(`changed: ${clip(oneLine(oldS), 90)} → ${clip(oneLine(newS), 90)}`);
  }
  const cmd = str(args.input, "command");
  if (cmd) facts.push(`ran: ${commandSummary(cmd)}`);

  // Error detection has to be narrow. A loose "contains the word error" match
  // fires on any file whose CONTENT mentions an error, and on success envelopes
  // like {"success":true,...} — observed marking every capture on a real
  // install as importance 6, which destroys ranking by making everything
  // top-priority. Trust the hook's own failure signal first; only fall back to
  // shape-based detection, and never on a declared success.
  const declaredSuccess = /"success"\s*:\s*true/.test(args.outputText);
  if (args.isFailure || (!declaredSuccess && looksLikeError(args.outputText))) {
    const line = errorLine(args.outputText);
    // A JSON blob is not a fact. Raw payloads leaking in here is the exact
    // defect this rewrite exists to remove.
    if (line && !isJsonish(line)) facts.push(`error: ${clip(line, 140)}`);
  }
  return facts.slice(0, 4);
}

/** JSON-shaped text must never become a title, fact, or narrative. */
function isJsonish(s: string): boolean {
  const t = s.trim();
  return (
    (t.startsWith("{") && t.includes('":')) ||
    (t.startsWith("[") && t.includes("{")) ||
    /^"?\w+"?\s*:\s*[{["]/.test(t)
  );
}

/** Error SHAPES, not the mere presence of the word. */
function looksLikeError(text: string): boolean {
  return (
    /^\s*(?:error|fatal|exception|traceback|panic)\b/im.test(text) ||
    /\b(?:[A-Z]\w*Error|error\s+TS\d+|TS\d{4}|SyntaxError|command not found)\b/.test(text) ||
    /\bexit(?:ed with)? (?:code|status) [1-9]/i.test(text) ||
    /\b(?:npm|yarn|pnpm) ERR!/.test(text)
  );
}

function errorLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const t = oneLine(line);
    if (!t || isJsonish(t)) continue;
    if (looksLikeError(t) || /\b(cannot|refused|denied|failed)\b/i.test(t)) return t;
  }
  return null;
}

/**
 * A human title describing the change. Falls back to the tool name only when
 * there is genuinely nothing else — and in that case the record is also marked
 * low-importance below, so retention can age it out.
 */
function titleFor(args: {
  toolName: string;
  type: ObservationType;
  input: Record<string, unknown>;
  paths: string[];
}): string {
  const { toolName, type, input, paths } = args;
  const cmd = str(input, "command");
  if (cmd) return clip(commandSummary(cmd), 80);

  const file = paths[0] ? baseName(paths[0]) : "";
  const oldS = oneLine(str(input, "old_string"));
  const newS = oneLine(str(input, "new_string"));
  if (file && oldS && newS) {
    // Short replacements are the most useful titles in the whole store.
    if (oldS.length <= 40 && newS.length <= 40) {
      return clip(`${file}: ${oldS} → ${newS}`, 80);
    }
    return clip(`Edited ${file}`, 80);
  }
  const pattern = str(input, "pattern");
  if (pattern) return clip(`Searched "${oneLine(pattern)}"`, 80);
  if (file) {
    const verb =
      type === "file_write"
        ? "Wrote"
        : type === "file_edit"
          ? "Edited"
          : type === "file_read"
            ? "Read"
            : "Touched";
    return clip(`${verb} ${file}`, 80);
  }
  return clip(toolName || "observation", 80);
}

/**
 * A sentence, never a JSON dump.
 *
 * Deliberately free of scaffolding labels and repeated paths. Downstream
 * consumers derive a conflict SUBJECT from the most frequent narrative terms,
 * so any boilerplate word we add ("output", "in <path>") competes with the real
 * subject: an early version of this produced the subject "ts output auth"
 * instead of "auth" purely from its own decoration. Paths already live in
 * `files`; facts already carry their own verbs.
 */
function narrativeFor(args: {
  title: string;
  facts: string[];
  outputText: string;
}): string {
  const parts: string[] = [args.title];
  if (args.facts.length > 0) parts.push(args.facts.join("; "));
  const out = summarizeOutput(args.outputText);
  if (out) parts.push(out);
  return clip(parts.join(". "), 600);
}

/**
 * Tool output is evidence, but most of it is a JSON envelope, and appending it
 * verbatim put payloads straight back into the body — the exact defect this
 * module exists to remove. Observed after the first pass:
 *
 *   "Wrote inspect-store.ts. {"type":"create","filePath":"…","content":"//\n…"
 *
 * i.e. an entire written file stored inside its own memory. So an envelope is
 * mined for the one or two fields a human would actually read, and everything
 * else is dropped. `content`/`file` fields are deliberately NOT harvested: they
 * are the whole payload, which is what we are trying not to keep.
 */
function summarizeOutput(text: string): string {
  const t = text.trim();
  if (!t) return "";
  // A success acknowledgement carries no semantic claim and only makes an
  // otherwise operation-derived memory depend on arbitrary host wording.
  if (/^(?:ok|success(?:ful(?:ly)?)?|done|updated|applied|complete(?:d)?)[.!]?$/i.test(t)) {
    return "";
  }
  if (!isJsonish(t)) return clip(oneLine(t), 220);

  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    // Malformed or truncated JSON is still a payload, not prose.
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const o = parsed as Record<string, unknown>;
  for (const key of ["stdout", "output", "stderr", "message", "error", "result"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) {
      const line = oneLine(v);
      // A nested payload is no better than the outer one.
      if (isJsonish(line)) return "";
      return clip(line, 220);
    }
  }
  return "";
}

export function buildSyntheticCompression(raw: RawObservation): CompressedObservation {
  const toolName = raw.toolName ?? raw.hookType;
  const inputText = asText(raw.toolInput);
  const outputText = asText(raw.toolOutput);

  // A user prompt is first-class memory, not a tool trace: the title is the
  // intent (the prompt's first non-empty line) and the narrative is the
  // prompt itself — never a clipped tool_input/tool_output concatenation.
  const prompt = typeof raw.userPrompt === "string" ? raw.userPrompt.trim() : "";
  if (prompt.length > 0) {
    const intent =
      prompt.split("\n").find((l) => l.trim().length > 0)?.trim() ?? prompt;
    const result: CompressedObservation = {
      id: raw.id,
      sessionId: raw.sessionId,
      timestamp: raw.timestamp,
      type: classify(toolName, raw.hookType),
      title: clip(intent, 80),
      facts: [],
      narrative: clip(prompt, 600),
      concepts: [],
      files: [],
      // Slightly above the tool-trace default: what the USER asked for is
      // the best signal of session intent for later recall.
      importance: 6,
      confidence: 0.5,
    };
    if (raw.modality) result.modality = raw.modality;
    if (raw.imageData) result.imageData = raw.imageData;
    if (raw.agentId) result.agentId = raw.agentId;
    return result;
  }

  const type = classify(toolName, raw.hookType);
  const input =
    raw.toolInput && typeof raw.toolInput === "object"
      ? (raw.toolInput as Record<string, unknown>)
      : {};
  const paths = filePaths(raw.toolInput);
  const isFailure = raw.hookType === "post_tool_failure";

  const title = titleFor({ toolName: toolName ?? "", type, input, paths });
  const facts = factsFrom({ toolName: toolName ?? "", input, outputText, isFailure });
  const narrative = narrativeFor({ title, facts, outputText });
  const concepts = conceptsFrom(
    paths,
    `${str(input, "old_string")} ${str(input, "new_string")} ${str(input, "command")} ${outputText}`,
  );

  // A bare read with no extractable signal is a log line, not knowledge.
  // Below the retention floor (5) it ages out instead of being promoted into a
  // permanent memory, which is how the store filled with `title: "Read"` rows.
  const barren = facts.length === 0 && concepts.length === 0;
  const importance =
    isFailure || facts.some((f) => f.startsWith("error:"))
      ? 6 // failures are the highest-value thing Déjà Fix has to work with
      : type === "file_read" && barren
        ? 3
        : barren
          ? 4
          : 5;

  const result: CompressedObservation = {
    id: raw.id,
    sessionId: raw.sessionId,
    timestamp: raw.timestamp,
    type,
    title,
    facts,
    narrative,
    concepts,
    files: paths,
    importance,
    confidence: facts.length > 0 ? 0.5 : 0.3,
  };
  // Raw tool input is NEVER stored as content: it is what turned memories into
  // JSON blobs. Keep only a clipped, single-line trace for debugging context.
  if (inputText) result.subtitle = clip(oneLine(inputText), 120);
  if (raw.modality) result.modality = raw.modality;
  if (raw.imageData) result.imageData = raw.imageData;
  if (raw.agentId) result.agentId = raw.agentId;
  return result;
}
