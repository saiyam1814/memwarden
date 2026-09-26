//
// Which files did a shell command read? Pure (no I/O): a conservative parse
// of the command line, so a memory captured from `sed -n 1,60p src/auth.ts`
// can carry the same file evidence as one captured from the Read tool.
//
// Why this exists: on a real month of use, 72% of captured tool calls were
// shell commands and 3% were the Read tool. Codex has no Read tool at all.
// Every file an agent looked at through `cat`/`sed -n`/`grep`/`head` was
// recorded as "sourced by command", so Verified Recall could never verify it
// and never notice when it went stale: 57 of 1,060 served memories verified.
//
// Soundness rules (a wrong "verified" is worse than a missing one):
// - Only known read-only viewers contribute files, with per-command argument
//   parsing (grep's first positional is a PATTERN, sed's is a script, …).
// - Anything that makes the command's output depend on something we cannot
//   fingerprint marks the result incomplete: another command in the chain,
//   a glob or variable argument, a directory, a stdout redirect to a file.
//   Incomplete evidence still records the files (drift still proves a memory
//   stale) but the caller caps the memory below "verified" (mixedTrust).
// - Command substitution, process substitution, heredocs, and unterminated
//   quotes abort the parse entirely: no shell evidence at all.
// - Candidates are only candidates: the caller keeps a file only if it
//   exists and hashes at capture, which also discards any token this parse
//   misread as a path.

import { isAbsolute, resolve } from "node:path";

export interface ShellReads {
  /** Absolute paths the command read (candidates; the caller checks them). */
  files: string[];
  /** True only when the command's output depends on nothing but `files`. */
  complete: boolean;
}

/** Hard cap on files taken from one command; more marks it incomplete. */
const MAX_SHELL_FILES = 16;

interface Token {
  text: string;
  /** Unquoted glob chars, `$`, or `~` outside a leading `~/`: unresolvable. */
  dynamic: boolean;
}

type Lexeme = { kind: "word"; token: Token } | { kind: "op"; op: string };

/**
 * A small POSIX-ish lexer: words (with quote/escape handling) and control
 * operators. Returns null for constructs whose reads cannot be known.
 */
function lex(command: string): Lexeme[] | null {
  const out: Lexeme[] = [];
  let i = 0;
  let word = "";
  let inWord = false;
  let dynamic = false;
  const flush = (): void => {
    if (inWord) out.push({ kind: "word", token: { text: word, dynamic } });
    word = "";
    inWord = false;
    dynamic = false;
  };
  while (i < command.length) {
    const c = command[i]!;
    const next = command[i + 1];
    if (c === "\\") {
      if (next === "\n") {
        i += 2; // line continuation
        continue;
      }
      if (next === undefined) return null;
      word += next;
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      for (; j < command.length; j++) {
        const d = command[j]!;
        if (d === "\\" && j + 1 < command.length) {
          buf += command[j + 1];
          j++;
          continue;
        }
        if (d === '"') break;
        if (d === "`" || (d === "$" && command[j + 1] === "(")) return null;
        if (d === "$") dynamic = true;
        buf += d;
      }
      if (j >= command.length) return null;
      word += buf;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "`") return null;
    if (c === "$") {
      if (next === "(") return null;
      dynamic = true;
      word += c;
      inWord = true;
      i++;
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") return null; // process substitution
    if (c === "<" && next === "<") return null; // heredoc / herestring
    if (c === "#" && !inWord) {
      // comment to end of line
      const nl = command.indexOf("\n", i);
      i = nl === -1 ? command.length : nl;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i++;
      continue;
    }
    if (c === "\n" || c === ";") {
      flush();
      out.push({ kind: "op", op: ";" });
      i++;
      continue;
    }
    if (c === "&" || c === "|") {
      flush();
      if (next === c) {
        out.push({ kind: "op", op: c + c });
        i += 2;
      } else if (c === "&" && next === ">") {
        out.push({ kind: "op", op: "&>" });
        i += 2;
      } else {
        out.push({ kind: "op", op: c === "|" ? "|" : ";" });
        i++;
      }
      continue;
    }
    if (c === ">" || c === "<") {
      // Redirections, with an optional fd prefix already in `word` ("2>").
      const fd = /^\d+$/.test(word) ? word : "";
      if (fd) {
        word = "";
        inWord = false;
      } else {
        flush();
      }
      let op = c;
      if (next === ">" && c === ">") op = ">>";
      if (next === "&") op = c + "&";
      i += op.length;
      out.push({ kind: "op", op: `${fd}${op}` });
      continue;
    }
    if (c === "*" || c === "?" || c === "[") dynamic = true;
    if (c === "~" && !inWord && next !== "/" && next !== undefined && next !== " ") {
      dynamic = true; // ~user
    }
    word += c;
    inWord = true;
    i++;
  }
  flush();
  return out;
}

interface Stage {
  argv: Token[];
  /** Position in its pipeline: 0 = reads its own args; >0 = also stdin. */
  stage: number;
  /** Files read through `<` redirection. */
  inputs: Token[];
  /** Wrote stdout to a real file (not /dev/null). */
  writes: boolean;
}

/** Split lexemes into pipeline stages with their redirections resolved. */
function stages(lexemes: Lexeme[]): Stage[] | null {
  const out: Stage[] = [];
  let cur: Stage = { argv: [], stage: 0, inputs: [], writes: false };
  const push = (nextStage: number): void => {
    if (cur.argv.length > 0 || cur.inputs.length > 0) out.push(cur);
    cur = { argv: [], stage: nextStage, inputs: [], writes: false };
  };
  for (let i = 0; i < lexemes.length; i++) {
    const l = lexemes[i]!;
    if (l.kind === "word") {
      cur.argv.push(l.token);
      continue;
    }
    const op = l.op;
    if (op === "|") {
      push(cur.stage + 1);
      continue;
    }
    if (op === ";" || op === "&&" || op === "||") {
      push(0);
      continue;
    }
    // A redirection: its target is the next word.
    const target = lexemes[i + 1];
    const isFdDup = op.endsWith("&") && op !== "&>";
    if (isFdDup) {
      // `2>&1`, `>&2`: the target is an fd number, not a file.
      if (target?.kind === "word" && /^\d+$|^-$/.test(target.token.text)) i++;
      continue;
    }
    if (target?.kind !== "word") return null;
    i++;
    if (op.endsWith("<")) {
      cur.inputs.push(target.token);
    } else if (target.token.text !== "/dev/null") {
      cur.writes = true;
    }
  }
  push(0);
  return out;
}

interface ViewerSpec {
  /** Short/long options that consume the next argument. */
  valueFlags?: readonly string[];
  /** Options that consume the next TWO arguments (jq --arg name value). */
  pairFlags?: readonly string[];
  /** The first positional is not a file (grep pattern, sed script, jq filter). */
  firstIsProgram?: boolean;
  /** Options that supply the program, so the first positional IS a file. */
  programFlags?: readonly string[];
  /** Refuse (treat as not-a-read) when any of these flags is present. */
  refuseFlags?: readonly string[];
  /** Required flag for the command to count as a pure read (sed -n). */
  requireFlag?: string;
  /**
   * With no file operands the command searches a directory tree, not stdin:
   * always for rg/ag, and for grep when any of these flags is present.
   */
  searchesTree?: true | readonly string[];
}

const GREP: ViewerSpec = {
  searchesTree: ["-r", "-R", "--recursive", "--dereference-recursive"],
  firstIsProgram: true,
  programFlags: ["-e", "-f", "--regexp", "--file"],
  valueFlags: [
    "-e", "-f", "-m", "-A", "-B", "-C", "-g", "-t", "-T", "-d", "-D",
    "--regexp", "--file", "--max-count", "--glob", "--type", "--type-not",
    "--context", "--after-context", "--before-context", "--include",
    "--exclude", "--color", "--colour", "-M", "--max-columns", "-j",
  ],
};

// Commands that only ever read their file operands and print derived output.
const VIEWERS: Readonly<Record<string, ViewerSpec>> = {
  cat: {},
  tac: {},
  nl: { valueFlags: ["-b", "-w", "-s", "-v", "-i", "-n"] },
  head: { valueFlags: ["-n", "-c"] },
  tail: { valueFlags: ["-n", "-c"], refuseFlags: ["-f", "-F", "--follow"] },
  wc: {},
  less: {},
  more: {},
  bat: { valueFlags: ["-l", "--language", "-r", "--line-range", "-H", "--highlight-line", "--style"] },
  sed: {
    requireFlag: "-n",
    firstIsProgram: true,
    programFlags: ["-e", "-f", "--expression", "--file"],
    valueFlags: ["-e", "-f", "--expression", "--file", "-l"],
    refuseFlags: ["-i", "--in-place"],
  },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: { ...GREP, searchesTree: true },
  ag: { ...GREP, searchesTree: true },
  jq: {
    firstIsProgram: true,
    programFlags: ["--from-file", "-f"],
    valueFlags: ["--indent", "--from-file", "-f", "--tab"],
    pairFlags: ["--arg", "--argjson", "--slurpfile", "--rawfile"],
  },
  diff: { valueFlags: ["-U", "-C", "--label", "-L", "--unified", "--context"] },
  cmp: {},
  sha256sum: {},
  sha1sum: {},
  md5sum: {},
  shasum: { valueFlags: ["-a", "--algorithm"] },
  md5: {},
  sort: { valueFlags: ["-k", "-t", "-S", "-T", "--key", "--field-separator"], refuseFlags: ["-o", "--output"] },
  uniq: { valueFlags: ["-f", "-s", "-w"] },
  cut: { valueFlags: ["-d", "-f", "-c", "-b", "--delimiter", "--fields"] },
  column: { valueFlags: ["-s", "-t", "-c"] },
  awk: { firstIsProgram: true, programFlags: ["-f"], valueFlags: ["-F", "-v", "-f"] },
  xxd: { valueFlags: ["-l", "-s", "-c", "-g"] },
  od: { valueFlags: ["-A", "-t", "-N", "-j"] },
  hexdump: { valueFlags: ["-n", "-s", "-e"] },
  strings: { valueFlags: ["-n"] },
};

/** Commands whose output does not depend on any file (`echo ---`). */
const CONSTANT = new Set(["echo", "printf", "true", ":", "false"]);

/** Resolve a path operand against the current directory (and ~ against home). */
function resolvePath(text: string, base: string, home: string | undefined): string | null {
  if (text === "~" || text.startsWith("~/")) {
    if (!home) return null;
    return resolve(home, text === "~" ? "." : text.slice(2));
  }
  return isAbsolute(text) ? resolve(text) : resolve(base, text);
}

/**
 * File operands of one viewer invocation, or null when the invocation is not
 * a pure read after all (sed without -n, sed -i, tail -f, sort -o, …).
 */
function viewerOperands(
  spec: ViewerSpec,
  args: Token[],
): { operands: Token[]; flags: Set<string> } | null {
  const flags = new Set<string>();
  const positional: Token[] = [];
  let programGiven = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const t = a.text;
    if (!endOfOptions && t === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && t.startsWith("-") && t !== "-") {
      const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      flags.add(name);
      // Short flag clusters (`-rn`, `-ni`) register each letter too.
      if (/^-[A-Za-z]{2,}$/.test(t)) for (const ch of t.slice(1)) flags.add(`-${ch}`);
      if (spec.programFlags?.includes(name)) programGiven = true;
      if (!t.includes("=")) {
        if (spec.pairFlags?.includes(name)) i += 2;
        else if (spec.valueFlags?.includes(name)) i += 1;
      }
      continue;
    }
    positional.push(a);
  }
  if (spec.refuseFlags?.some((f) => flags.has(f))) return null;
  if (spec.requireFlag && !flags.has(spec.requireFlag)) return null;
  // `sed -i.bak`, `sed -ibak`: an attached in-place suffix.
  if (spec.refuseFlags?.includes("-i") && [...flags].some((f) => /^-[a-z]*i/.test(f) && f.startsWith("-i"))) {
    return null;
  }
  const files = spec.firstIsProgram && !programGiven ? positional.slice(1) : positional;
  return { operands: files.filter((f) => f.text !== "-"), flags };
}

/**
 * Parse a shell command line for the files it reads. Returns null when the
 * command cannot be analyzed (substitutions, heredocs, bad quoting).
 */
export function extractShellReads(
  command: string,
  base: string,
  home?: string,
): ShellReads | null {
  const lexemes = lex(command);
  if (!lexemes) return null;
  const parts = stages(lexemes);
  if (!parts) return null;

  const files: string[] = [];
  let complete = true;
  let cwd = base;
  const add = (tok: Token): void => {
    if (tok.dynamic) {
      complete = false;
      return;
    }
    const abs = resolvePath(tok.text, cwd, home);
    if (!abs) {
      complete = false;
      return;
    }
    if (!files.includes(abs)) files.push(abs);
  };

  for (const part of parts) {
    // Strip leading VAR=value assignments.
    let argv = part.argv;
    while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!.text)) {
      argv = argv.slice(1);
    }
    for (const input of part.inputs) add(input);
    if (part.writes) complete = false;
    if (argv.length === 0) continue;
    const cmd = argv[0]!.text.replace(/^.*\//, ""); // /usr/bin/cat -> cat
    const args = argv.slice(1);

    if (cmd === "cd" || cmd === "pushd") {
      const target = args[0];
      if (!target || target.dynamic || target.text === "-" || args.length > 1) return null;
      const next = resolvePath(target.text, cwd, home);
      if (!next) return null;
      cwd = next;
      continue;
    }
    if (cmd === "export" || cmd === "set" || cmd === "local") continue;
    if (CONSTANT.has(cmd)) continue;

    const spec = VIEWERS[cmd];
    if (!spec) {
      // Any other command: its output depends on state we cannot fingerprint.
      complete = false;
      continue;
    }
    const parsed = viewerOperands(spec, args);
    if (!parsed) {
      complete = false; // not a pure read (sed -i, tail -f, …)
      continue;
    }
    const tree = spec.searchesTree;
    if (
      parsed.operands.length === 0 &&
      part.stage === 0 &&
      (tree === true || (Array.isArray(tree) && tree.some((f) => parsed.flags.has(f))))
    ) {
      complete = false; // `rg foo`, `grep -r foo`: the whole working tree
    }
    for (const op of parsed.operands) add(op);
  }

  if (files.length > MAX_SHELL_FILES) {
    return { files: files.slice(0, MAX_SHELL_FILES), complete: false };
  }
  return { files, complete };
}

/**
 * The command line of a shell tool call, from the shapes hosts send:
 * a string (`Bash`, Codex `exec`), or an argv array such as
 * `["bash", "-lc", "cat x"]` (Codex shell).
 */
export function shellCommandOf(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const cmd = (toolInput as Record<string, unknown>)["command"];
  if (typeof cmd === "string") return cmd.trim() || undefined;
  if (Array.isArray(cmd) && cmd.every((c) => typeof c === "string")) {
    const argv = cmd as string[];
    const shell = argv[0]?.replace(/^.*\//, "");
    const flagIdx = argv.findIndex((a, i) => i > 0 && /^-\w*c$/.test(a));
    if (shell && /^(?:ba|z|da|k)?sh$/.test(shell) && flagIdx > 0 && argv[flagIdx + 1]) {
      return argv[flagIdx + 1];
    }
    return argv
      .map((a) => (/^[\w./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))
      .join(" ");
  }
  return undefined;
}
