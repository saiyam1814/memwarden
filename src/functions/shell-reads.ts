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
// Soundness rules. A wrong "verified" is worse than a missing one, and every
// rule below exists because an adversarial review produced a false verified
// without it:
// - Only local shell tools are parsed (never an MCP tool that runs a command
//   on another machine: local files cannot vouch for remote output).
// - Only known read-only viewers contribute files, with per-command option
//   parsing that handles spaced, `=`, attached, and clustered values. Options
//   that name a file the command reads (`grep -f`, `jq --rawfile`) contribute
//   that file too.
// - Anything that makes the output depend on something we cannot fingerprint
//   marks the result incomplete: another command in the chain, a glob, brace
//   expansion, a variable, `..` segments, a temp file, a directory, a program
//   that can read or run more than its operands (sed `r`/`w`/`e`, awk
//   `getline`/`system`, jq `env`/`import`), a stdout redirect to a file.
//   Incomplete evidence still records the files (drift still proves a memory
//   stale) but the caller caps the memory below "verified" (mixedTrust).
// - `cd` only counts when absolute and joined by `&&`; any other `cd`, and
//   command/process substitution, heredocs, or bad quoting, abort the parse:
//   no shell evidence at all.
// - Candidates are only candidates: the caller hashes them at capture, and
//   any candidate that does not hash caps the memory as incomplete.

import { isAbsolute, resolve } from "node:path";

export interface ShellReads {
  /** Absolute paths the command read (candidates; the caller checks them). */
  files: string[];
  /** True only when the command's output depends on nothing but `files`. */
  complete: boolean;
}

/** Hard cap on files taken from one command; more marks it incomplete. */
const MAX_SHELL_FILES = 16;
/** Longer command lines are not analyzed (the parse must stay cheap). */
const MAX_COMMAND_CHARS = 8_000;

// Local shell tools, by normalized name (lowercase, alphanumerics only).
// Hosts spell them differently: Claude Code `Bash`, Codex `shell`/`exec`/
// `exec_command`/`local_shell`, Gemini `run_shell_command`, Cursor
// `run_terminal_cmd`, Kiro `executeBash`, OpenCode `bash`.
const LOCAL_SHELL_TOOLS = new Set([
  "bash", "shell", "sh", "zsh", "exec", "execcommand", "localshell", "runshellcommand",
  "runterminalcmd", "executecommand", "executebash", "terminal", "runcommand",
]);

/** True for a tool that runs its command in a local shell on this machine. */
export function isLocalShellTool(toolName: string | undefined): boolean {
  if (!toolName || toolName.startsWith("mcp__")) return false;
  return LOCAL_SHELL_TOOLS.has(toolName.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

interface Token {
  text: string;
  /** Glob chars, brace expansion, `$`, `(`, or `~user`: unresolvable. */
  dynamic: boolean;
  /** Began with an unquoted `~` (the shell expands it to $HOME). */
  tilde: boolean;
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
  let tilde = false;
  const flush = (): void => {
    if (inWord) out.push({ kind: "word", token: { text: word, dynamic, tilde } });
    word = "";
    inWord = false;
    dynamic = false;
    tilde = false;
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
          // Inside double quotes a backslash only escapes these; otherwise it
          // stays literal (`"a\b"` is the three characters a, \, b).
          const e = command[j + 1]!;
          if (e === "$" || e === "`" || e === '"' || e === "\\" || e === "\n") {
            if (e !== "\n") buf += e;
            j++;
            continue;
          }
          buf += d;
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
    if (c === "<" && next === ">") return null; // read-write open
    if (c === ">" && next === "|") return null; // clobber
    if (c === "#" && !inWord) {
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
      } else if (c === "|" && next === "&") {
        out.push({ kind: "op", op: "|" });
        i += 2;
      } else {
        out.push({ kind: "op", op: c === "|" ? "|" : "&" });
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
      else if (next === "&") op = c + "&";
      i += op.length;
      out.push({ kind: "op", op: `${fd}${op}` });
      continue;
    }
    if (c === "*" || c === "?" || c === "[" || c === "(" || c === ")") dynamic = true;
    if (c === "{" && /^\{[^}]*(?:,|\.\.)[^}]*\}/.test(command.slice(i))) dynamic = true;
    if (c === "~" && !inWord) {
      if (next === undefined || next === "/" || next === " ") tilde = true;
      else dynamic = true; // ~user, ~+
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
  /** Position in its pipeline: 0 = reads its own operands; >0 = also stdin. */
  stage: number;
  /** Operator that joined this stage to the previous one (null = first). */
  joinBefore: string | null;
  /** Operator that joins it to the next one (null = last). */
  joinAfter: string | null;
  /** Files redirected into stdin (fd 0 only). */
  inputs: Token[];
  /** Wrote stdout to a real file (not /dev/null). */
  writes: boolean;
}

/** Split lexemes into pipeline stages with their redirections resolved. */
function stages(lexemes: Lexeme[]): Stage[] | null {
  const out: Stage[] = [];
  let cur: Stage = { argv: [], stage: 0, joinBefore: null, joinAfter: null, inputs: [], writes: false };
  let pendingJoin: string | null = null;
  const push = (op: string, nextStage: number): void => {
    cur.joinAfter = op;
    if (cur.argv.length > 0 || cur.inputs.length > 0) out.push(cur);
    pendingJoin = op;
    cur = { argv: [], stage: nextStage, joinBefore: pendingJoin, joinAfter: null, inputs: [], writes: false };
  };
  for (let i = 0; i < lexemes.length; i++) {
    const l = lexemes[i]!;
    if (l.kind === "word") {
      cur.argv.push(l.token);
      continue;
    }
    const op = l.op;
    if (op === "|") {
      push("|", cur.stage + 1);
      continue;
    }
    if (op === ";" || op === "&&" || op === "||" || op === "&") {
      push(op, 0);
      continue;
    }
    // A redirection; its target is the next word.
    const target = lexemes[i + 1];
    if (target?.kind !== "word") return null;
    i++;
    const fdMatch = /^(\d*)(.*)$/.exec(op)!;
    const fd = fdMatch[1] ?? "";
    const kind = fdMatch[2] ?? "";
    if (kind === ">&" || kind === "<&") {
      // `2>&1`, `>&-`: a descriptor, not a file. `>&file` writes a file.
      if (/^\d+$|^-$/.test(target.token.text)) continue;
      cur.writes = true;
      continue;
    }
    if (kind === "<") {
      if (fd === "" || fd === "0") cur.inputs.push(target.token);
      continue; // other fds are never the command's stdin
    }
    if (target.token.text !== "/dev/null") cur.writes = true;
  }
  cur.joinAfter = null;
  if (cur.argv.length > 0 || cur.inputs.length > 0) out.push(cur);
  return out;
}

interface ViewerSpec {
  /** Options that consume a value (spaced, `=`, or attached). */
  valueFlags?: readonly string[];
  /** Options whose value is a FILE the command reads (also value flags). */
  fileFlags?: readonly string[];
  /** Options that consume two values; the second is a file (jq --rawfile). */
  pairFileFlags?: readonly string[];
  /** Options that consume two values, neither a file (jq --arg name value). */
  pairFlags?: readonly string[];
  /** The first positional is not a file (grep pattern, sed script, jq filter). */
  firstIsProgram?: boolean;
  /** Options that supply the program, so the first positional IS a file. */
  programFlags?: readonly string[];
  /** Any of these makes the command something other than a pure read. */
  refuseFlags?: readonly string[];
  /** Required flag for the command to count as a pure read (sed -n). */
  requireFlag?: string;
  /** With no file operands it searches a directory tree (always, or with these flags). */
  searchesTree?: true | readonly string[];
  /** Options with an optional value that can only be attached (sed -i.bak). */
  attachedOnlyFlags?: readonly string[];
  /** A program that can read or run beyond its operands (see programIsSafe). */
  programCheck?: "sed" | "awk" | "jq";
  /** Only the first operand is an input (uniq in [out]); more is a write. */
  singleInput?: boolean;
}

const GREP_BASE: ViewerSpec = {
  searchesTree: ["-r", "-R", "--recursive", "--dereference-recursive"],
  firstIsProgram: true,
  programFlags: ["-e", "-f", "--regexp", "--file"],
  fileFlags: ["-f", "--file"],
  valueFlags: [
    "-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count",
    "--context", "--after-context", "--before-context", "--include", "--exclude",
    "--exclude-dir", "--label", "--binary-files", "--devices", "--directories",
  ],
};

const RG: ViewerSpec = {
  ...GREP_BASE,
  searchesTree: true,
  valueFlags: [
    ...(GREP_BASE.valueFlags ?? []), "-g", "-t", "-T", "-M", "-j", "--glob", "--iglob",
    "--type", "--type-not", "--max-columns", "--threads", "--max-depth", "--sort", "--sortr",
    "--colors", "--encoding", "-E",
  ],
  refuseFlags: ["--pre", "--pre-glob", "-z", "--search-zip"],
};

// Commands that only ever read their file operands and print derived output.
const VIEWERS: Readonly<Record<string, ViewerSpec>> = {
  cat: {},
  tac: {},
  nl: { valueFlags: ["-b", "-w", "-s", "-v", "-i", "-n"] },
  head: { valueFlags: ["-n", "-c"] },
  tail: { valueFlags: ["-n", "-c"], refuseFlags: ["-f", "-F", "--follow"] },
  wc: {},
  bat: {
    valueFlags: ["-l", "--language", "-r", "--line-range", "-H", "--highlight-line", "--style"],
    refuseFlags: ["-d", "--diff"],
  },
  sed: {
    requireFlag: "-n",
    firstIsProgram: true,
    programFlags: ["-e", "-f", "--expression", "--file"],
    fileFlags: ["-f", "--file"],
    valueFlags: ["-e", "-f", "--expression", "--file", "-l"],
    refuseFlags: ["-i", "--in-place"],
    attachedOnlyFlags: ["-i"],
    programCheck: "sed",
  },
  grep: GREP_BASE,
  egrep: GREP_BASE,
  fgrep: GREP_BASE,
  rg: RG,
  ag: { ...RG, refuseFlags: ["-z", "--search-zip"] },
  jq: {
    firstIsProgram: true,
    programFlags: ["--from-file", "-f"],
    fileFlags: ["--from-file", "-f"],
    valueFlags: ["--indent", "--from-file", "-f"],
    pairFlags: ["--arg", "--argjson"],
    pairFileFlags: ["--slurpfile", "--rawfile"],
    refuseFlags: ["--args", "--jsonargs", "-L"],
    programCheck: "jq",
  },
  diff: {
    valueFlags: ["-U", "-C", "--label", "-L", "--unified", "--context", "--from-file", "--to-file"],
    fileFlags: ["--from-file", "--to-file"],
  },
  cmp: {},
  sha256sum: { refuseFlags: ["-c", "--check"] },
  sha1sum: { refuseFlags: ["-c", "--check"] },
  md5sum: { refuseFlags: ["-c", "--check"] },
  shasum: { valueFlags: ["-a", "--algorithm"], refuseFlags: ["-c", "--check"] },
  md5: {},
  sort: {
    valueFlags: ["-k", "-t", "-S", "-T", "-o", "--key", "--field-separator", "--output"],
    refuseFlags: ["-o", "--output"],
  },
  uniq: { valueFlags: ["-f", "-s", "-w"], singleInput: true },
  cut: { valueFlags: ["-d", "-f", "-c", "-b", "--delimiter", "--fields"] },
  column: { valueFlags: ["-s", "-c", "-o"] },
  awk: { firstIsProgram: true, programFlags: ["-f"], fileFlags: ["-f"], valueFlags: ["-F", "-v", "-f"], programCheck: "awk" },
  xxd: { valueFlags: ["-l", "-s", "-c", "-g"], singleInput: true },
  od: { valueFlags: ["-A", "-t", "-N", "-j"] },
  hexdump: { valueFlags: ["-n", "-s", "-e"] },
  strings: { valueFlags: ["-n"] },
};

/** Commands whose output does not depend on any file (`echo ---`). */
const CONSTANT = new Set(["echo", "printf", "true", ":", "false"]);

// Inline assignments that do not change what a viewer reads or prints.
const HARMLESS_ASSIGNMENT = /^(?:LC_[A-Z]+|LANG|TZ|NO_COLOR|TERM|COLUMNS)=/;

// Scratch space: files here are transient. Evidence from them would read as
// "stale: deleted" (refused, and listed as firewall evidence at every session
// start) once the OS or the agent cleans up.
const TEMP_PREFIXES = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", "/var/tmp/"];

function isTempPath(abs: string, tmpdir: string | undefined): boolean {
  if (TEMP_PREFIXES.some((p) => abs.startsWith(p))) return true;
  if (tmpdir && abs.startsWith(tmpdir.endsWith("/") ? tmpdir : `${tmpdir}/`)) return true;
  return false;
}

/** Resolve an operand against the current directory (and ~ against home). */
function resolveOperand(tok: Token, base: string, home: string | undefined): string | null {
  const t = tok.text;
  if (tok.tilde && (t === "~" || t.startsWith("~/"))) {
    if (!home) return null;
    return resolve(home, t === "~" ? "." : t.slice(2));
  }
  // `..` is resolved by the kernel through symlinks, not lexically; a lexical
  // resolution can name a different file than the one actually read.
  if (t.split("/").includes("..")) return null;
  return isAbsolute(t) ? resolve(t) : resolve(base, t);
}

// sed: addresses (numbers, $, n~m, +n) with p, =, l, q only. Regex
// addresses, and every command that reads, writes, or executes (r R w W e,
// and the s///w and s///e flags) are refused by construction.
const SAFE_SED = /^\s*(?:(?:\d+|\$)(?:\s*(?:,|~)\s*(?:\d+|\$|\+\d+|~\d+))?)?\s*!?\s*[pl=qQ]\s*(?:;\s*(?:(?:\d+|\$)(?:\s*(?:,|~)\s*(?:\d+|\$|\+\d+|~\d+))?)?\s*!?\s*[pl=qQ]\s*)*;?\s*$/;
const AWK_UNSAFE = /getline|system|ENVIRON|>|\||close\s*\(|fflush|@include|@load/;
const JQ_UNSAFE = /\benv\b|\$ENV|input_filename|\bimport\b|\binclude\b|\binputs?\b|\bnow\b|\bdebug\b|\bstderr\b|\$__loc__|\bgetpath\b.*\$ENV/;

function programIsSafe(kind: "sed" | "awk" | "jq", program: string): boolean {
  if (kind === "sed") return SAFE_SED.test(program);
  if (kind === "awk") return !AWK_UNSAFE.test(program);
  return !JQ_UNSAFE.test(program);
}

interface ParsedViewer {
  operands: Token[];
  /** Files named by options (grep -f pats.txt, jq --rawfile n f). */
  optionFiles: Token[];
  flags: Set<string>;
  /** Program text: the first positional, or every `-e`-style value. */
  programs: Token[];
  /** The program came from a file (`sed -f`, `awk -f`): it cannot be checked. */
  programFromFile: boolean;
}

/**
 * Operands of one viewer invocation, or null when the invocation is not a
 * pure read after all (sed without -n, sed -i, tail -f, sort -o, …).
 */
function parseViewer(spec: ViewerSpec, args: Token[]): ParsedViewer | null {
  const flags = new Set<string>();
  const positional: Token[] = [];
  const optionFiles: Token[] = [];
  const programs: Token[] = [];
  let programGiven = false;
  let programFromFile = false;
  let endOfOptions = false;
  const takesValue = (f: string): boolean =>
    !!spec.valueFlags?.includes(f) || !!spec.fileFlags?.includes(f);
  const noteValue = (flag: string, value: Token | undefined): void => {
    const isFile = !!spec.fileFlags?.includes(flag);
    if (spec.programFlags?.includes(flag)) {
      programGiven = true;
      if (isFile) programFromFile = true;
      else if (value) programs.push(value);
    }
    if (value && isFile) optionFiles.push(value);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const t = a.text;
    if (endOfOptions || !t.startsWith("-") || t === "-") {
      positional.push(a);
      continue;
    }
    if (t === "--") {
      endOfOptions = true;
      continue;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      flags.add(name);
      if (spec.pairFlags?.includes(name) || spec.pairFileFlags?.includes(name)) {
        if (spec.pairFileFlags?.includes(name) && args[i + 2]) optionFiles.push(args[i + 2]!);
        i += 2;
        continue;
      }
      if (eq !== -1) {
        noteValue(name, { ...a, text: t.slice(eq + 1) });
      } else if (takesValue(name)) {
        noteValue(name, args[i + 1]);
        i += 1;
      }
      continue;
    }
    // A short-option cluster: `-rn`, `-A3`, `-nf pats`, `-i.bak`, `-20`.
    for (let k = 1; k < t.length; k++) {
      const flag = `-${t[k]}`;
      flags.add(flag);
      if (spec.attachedOnlyFlags?.includes(flag)) break; // the rest is its value
      if (takesValue(flag)) {
        const attached = t.slice(k + 1);
        if (attached) {
          noteValue(flag, { ...a, text: attached });
        } else {
          noteValue(flag, args[i + 1]);
          i += 1;
        }
        break;
      }
    }
  }
  if (spec.refuseFlags?.some((f) => flags.has(f))) return null;
  if (spec.requireFlag && !flags.has(spec.requireFlag)) return null;
  const hasProgram = spec.firstIsProgram && !programGiven;
  if (hasProgram && positional[0]) programs.push(positional[0]);
  const operands = (hasProgram ? positional.slice(1) : positional).filter((f) => f.text !== "-");
  return { operands, optionFiles, flags, programs, programFromFile };
}

/**
 * Parse a shell command line for the files it reads. Returns null when the
 * command cannot be analyzed (substitutions, heredocs, bad quoting, a `cd`
 * whose effect is not certain).
 */
export interface ShellReadOptions {
  /** Expands a leading unquoted `~`. */
  home?: string;
  /** The OS temp directory, in addition to the well-known temp roots. */
  tmpdir?: string;
  /** Files under the project are never "temp", even if the project is. */
  projectRoot?: string;
}

export function extractShellReads(
  command: string,
  base: string,
  opts: ShellReadOptions = {},
): ShellReads | null {
  const { home, tmpdir } = opts;
  const projectRoot = opts.projectRoot ?? base;
  const underProject = (abs: string): boolean =>
    abs === projectRoot || abs.startsWith(projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`);
  if (command.length > MAX_COMMAND_CHARS) return null;
  const lexemes = lex(command);
  if (!lexemes) return null;
  const parts = stages(lexemes);
  if (!parts) return null;

  const files = new Set<string>();
  let complete = true;
  let cwd = base;
  const add = (tok: Token): void => {
    if (tok.dynamic) {
      complete = false;
      return;
    }
    const abs = resolveOperand(tok, cwd, home);
    if (!abs || (isTempPath(abs, tmpdir) && !underProject(abs))) {
      complete = false;
      return;
    }
    if (files.size >= MAX_SHELL_FILES) {
      complete = false;
      return;
    }
    files.add(abs);
  };

  for (const part of parts) {
    let argv = part.argv;
    // Inline assignments: harmless ones are stripped; anything else (PATH,
    // GREP_OPTIONS, LESSOPEN, …) can change what the command does.
    while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!.text)) {
      if (!HARMLESS_ASSIGNMENT.test(argv[0]!.text)) complete = false;
      argv = argv.slice(1);
    }
    if (part.writes) complete = false;
    if (argv.length === 0) {
      for (const input of part.inputs) add(input);
      continue;
    }
    const raw = argv[0]!.text;
    // A path-qualified command is only a known viewer from a system bin dir;
    // `./cat` or `node_modules/.bin/jq` could be anything.
    if (raw.includes("/") && !/^\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?bin\/[^/]+$/.test(raw)) {
      complete = false;
      continue;
    }
    const cmd = raw.replace(/^.*\//, "");
    const args = argv.slice(1);

    if (cmd === "cd" || cmd === "pushd") {
      // Only a cd whose effect is certain: absolute, first in its pipeline,
      // and followed by `&&` (so what comes next runs only after it worked).
      // A relative cd is ambiguous: hosts report the cwd before or after the
      // command, and resolving it against the wrong one names another file.
      const target = args[0];
      if (
        !target ||
        args.length > 1 ||
        target.dynamic ||
        target.tilde ||
        !isAbsolute(target.text) ||
        target.text.split("/").includes("..") ||
        part.stage !== 0 ||
        part.joinAfter !== "&&" ||
        part.joinBefore === "||" ||
        part.joinBefore === "|"
      ) {
        return null;
      }
      cwd = resolve(target.text);
      continue;
    }
    if (cmd === "set" && args.every((a) => /^[-+][euxo]+$|^pipefail$/.test(a.text))) {
      continue; // `set -euo pipefail` changes failure handling, not output
    }
    if (cmd === "export" || cmd === "set" || cmd === "local") {
      complete = false; // may change the environment the next command sees
      continue;
    }
    if (CONSTANT.has(cmd)) {
      if (args.some((a) => a.dynamic)) complete = false; // `echo $HOME`, `echo *`
      continue;
    }

    const spec = VIEWERS[cmd];
    if (!spec) {
      complete = false; // any other command: output we cannot fingerprint
      continue;
    }
    const parsed = parseViewer(spec, args);
    if (!parsed) {
      complete = false; // not a pure read (sed -i, tail -f, sha256sum -c, …)
      continue;
    }
    if (spec.programCheck) {
      const kind = spec.programCheck;
      if (
        parsed.programFromFile ||
        parsed.programs.length === 0 ||
        parsed.programs.some((p) => p.dynamic || !programIsSafe(kind, p.text))
      ) {
        complete = false;
      }
    }
    if (spec.singleInput && parsed.operands.length > 1) {
      complete = false; // `uniq in out` writes `out`
      parsed.operands.length = 1;
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
    for (const f of parsed.optionFiles) add(f);
    // stdin is read only when there are no operands (or an explicit `-`).
    const readsStdin =
      parsed.operands.length === 0 || args.some((a) => a.text === "-");
    if (readsStdin) for (const input of part.inputs) add(input);
  }

  return { files: [...files], complete };
}

/**
 * The command line of a shell tool call, from the shapes hosts send:
 * a string (`Bash`, Codex `exec`), an argv array such as
 * `["bash", "-lc", "cat x"]` (Codex shell), under `command` or `cmd`.
 */
export function shellCommandOf(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const rec = toolInput as Record<string, unknown>;
  const cmd = rec["command"] ?? rec["cmd"];
  if (typeof cmd === "string") return cmd.trim() || undefined;
  if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === "string")) {
    const argv = cmd as string[];
    const shell = argv[0]!.replace(/^.*\//, "");
    // `bash -lc "<script>"`: the script is argv[2]; any other layout is
    // exec'd as-is, so it is quoted word for word (no expansion happens).
    if (/^(?:ba|z|da|k)?sh$/.test(shell) && /^-\w*c$/.test(argv[1] ?? "") && argv[2]) {
      return argv[2];
    }
    return argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  }
  return undefined;
}
