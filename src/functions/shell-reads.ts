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

// Local shell tools per host, by the exact tool name each host's hooks send.
// Keyed by host because the bare names are generic: a Gemini CLI MCP server
// can surface a remote-exec tool as plain `exec`, and local files must never
// vouch for output produced on another machine. Observed live: Claude Code
// and Codex hooks both send `Bash`.
const LOCAL_SHELL_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["Bash"],
  codex: ["Bash", "shell", "exec", "exec_command", "local_shell"],
  cursor: ["Shell", "run_terminal_cmd", "Bash"],
  gemini: ["run_shell_command"],
  kiro: ["executeBash", "execute_bash"],
  opencode: ["bash"],
};
// Payloads that do not name their host: only the unambiguous Claude-style name.
const UNKNOWN_HOST_SHELL_TOOLS = ["Bash"];

/** True for a tool that runs its command in a local shell on this machine. */
export function isLocalShellTool(toolName: string | undefined, host?: string): boolean {
  if (!toolName || toolName.startsWith("mcp__")) return false;
  const allowed = host ? LOCAL_SHELL_TOOLS[host] : UNKNOWN_HOST_SHELL_TOOLS;
  return !!allowed?.includes(toolName);
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
      // A newline right after `&&`, `||`, or `|` continues the list; only a
      // newline elsewhere ends a command (as `;` does).
      const prev = out[out.length - 1];
      const continues =
        c === "\n" && prev?.kind === "op" && (prev.op === "&&" || prev.op === "||" || prev.op === "|");
      if (!continues) out.push({ kind: "op", op: ";" });
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
      if (/^0*$/.test(fd)) cur.inputs.push(target.token); // "", "0", "00" are stdin
      continue; // other fds are never the command's stdin
    }
    if (target.token.text !== "/dev/null") cur.writes = true;
  }
  cur.joinAfter = null;
  if (cur.argv.length > 0 || cur.inputs.length > 0) out.push(cur);
  return out;
}

interface ViewerSpec {
  /**
   * Every option the viewer is allowed to carry, as an allowlist. An option
   * that is not listed (including a GNU/BSD long-option ABBREVIATION such as
   * `--ch` for `--check`) makes the read incomplete: its meaning, whether it
   * consumes the next word, and whether it reads another file are unknown.
   */
  flags?: readonly string[];
  /** Options that require a value (spaced, `=`, or attached). */
  valueFlags?: readonly string[];
  /** Options whose value is a FILE the command reads (also value options). */
  fileFlags?: readonly string[];
  /** Options with an OPTIONAL value: only the `=`/attached form carries one;
   * the bare form never consumes the next word. */
  optionalFlags?: readonly string[];
  /** Options where implementations disagree on whether a spaced value is
   * consumed (GNU requires it, BSD makes it optional): bare = incomplete. */
  ambiguousFlags?: readonly string[];
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
  /** `-20` style numeric options (head/tail line counts). */
  numericShort?: boolean;
  /** Options are whole words, never getopt clusters (xxd). */
  wholeWordOptions?: boolean;
}

const GREP: ViewerSpec = {
  searchesTree: ["-r", "-R", "--recursive", "--dereference-recursive"],
  firstIsProgram: true,
  programFlags: ["-e", "-f", "--regexp", "--file"],
  fileFlags: ["-f", "--file"],
  flags: [
    "-i", "-v", "-w", "-x", "-c", "-l", "-L", "-n", "-h", "-H", "-o", "-q", "-s", "-r", "-R",
    "-E", "-F", "-G", "-P", "-z", "-Z", "-a", "-I", "-b", "-U", "--ignore-case",
    "--invert-match", "--word-regexp", "--line-regexp", "--count", "--files-with-matches",
    "--files-without-match", "--line-number", "--no-filename", "--with-filename",
    "--only-matching", "--quiet", "--silent", "--no-messages", "--recursive",
    "--dereference-recursive", "--extended-regexp", "--fixed-strings", "--basic-regexp",
    "--perl-regexp", "--text", "--null", "--null-data", "--byte-offset", "--binary",
  ],
  valueFlags: [
    "-e", "-m", "-A", "-B", "--regexp", "--max-count", "--after-context", "--before-context",
    "--include", "--exclude", "--exclude-dir", "--label",
  ],
  optionalFlags: ["--color", "--colour"],
  // GNU grep: `-C NUM` / `--context NUM` require the number; BSD (macOS)
  // makes it optional, so there `-C 2 foo f` treats 2 as the PATTERN.
  ambiguousFlags: ["-C", "--context"],
};

const RG: ViewerSpec = {
  searchesTree: true,
  firstIsProgram: true,
  programFlags: ["-e", "-f", "--regexp", "--file"],
  fileFlags: ["-f", "--file"],
  flags: [
    "-i", "-S", "-s", "-v", "-w", "-x", "-c", "-l", "-n", "-N", "-H", "-I", "-o", "-q", "-F",
    "-U", "-P", "-a", "-L", "-u", "--ignore-case", "--smart-case", "--case-sensitive",
    "--invert-match", "--word-regexp", "--line-regexp", "--count", "--count-matches",
    "--files-with-matches", "--files-without-match", "--line-number", "--no-line-number",
    "--with-filename", "--no-filename", "--only-matching", "--quiet", "--fixed-strings",
    "--multiline", "--pcre2", "--text", "--follow", "--hidden", "--no-ignore", "--no-heading",
    "--heading", "--vimgrep", "--json", "--trim", "--no-messages", "--column", "--byte-offset",
  ],
  valueFlags: [
    "-e", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-M", "-j", "-E", "--regexp", "--glob",
    "--iglob", "--type", "--type-not", "--max-count", "--after-context", "--before-context",
    "--context", "--max-columns", "--threads", "--max-depth", "--sort", "--sortr", "--color",
    "--colors", "--encoding",
  ],
};

const HEAD_TAIL_VALUES = ["-n", "-c", "--lines", "--bytes"];

// Commands that only ever read their file operands and print derived output.
const VIEWERS: Readonly<Record<string, ViewerSpec>> = {
  cat: {
    flags: ["-n", "-b", "-s", "-v", "-e", "-t", "-A", "-E", "-T", "-u", "--number",
      "--number-nonblank", "--squeeze-blank", "--show-all", "--show-ends", "--show-tabs",
      "--show-nonprinting"],
  },
  tac: { flags: ["-b", "-r", "--before", "--regex"], valueFlags: ["-s", "--separator"] },
  nl: { flags: ["-p"], valueFlags: ["-b", "-w", "-s", "-v", "-i", "-n", "-h", "-f", "-d", "-l"] },
  head: { flags: ["-q", "-v", "--quiet", "--silent", "--verbose"], valueFlags: HEAD_TAIL_VALUES, numericShort: true },
  tail: {
    flags: ["-q", "-v", "-r", "--quiet", "--silent", "--verbose", "-f", "-F", "--follow"],
    valueFlags: HEAD_TAIL_VALUES,
    refuseFlags: ["-f", "-F", "--follow"],
    numericShort: true,
  },
  wc: { flags: ["-l", "-w", "-c", "-m", "-L", "--lines", "--words", "--bytes", "--chars", "--max-line-length"] },
  bat: {
    flags: ["-n", "-p", "-A", "-P", "--plain", "--number", "--show-all", "-d", "--diff"],
    valueFlags: ["-l", "--language", "-r", "--line-range", "-H", "--highlight-line", "--style",
      "--theme", "--paging", "--color", "--wrap", "--tabs", "--terminal-width"],
    refuseFlags: ["-d", "--diff"],
  },
  sed: {
    requireFlag: "-n",
    firstIsProgram: true,
    programFlags: ["-e", "-f", "--expression", "--file"],
    fileFlags: ["-f", "--file"],
    flags: ["-n", "-E", "-r", "-s", "-u", "-z", "--quiet", "--silent", "--regexp-extended",
      "--posix", "--separate", "--null-data", "--unbuffered", "-i", "--in-place"],
    valueFlags: ["-e", "--expression", "--line-length"],
    // GNU `-l N` is a line length; BSD/macOS `-l` is a plain flag (line
    // buffering), so a spaced value is ambiguous.
    ambiguousFlags: ["-l"],
    refuseFlags: ["-i", "--in-place"],
    attachedOnlyFlags: ["-i"],
    programCheck: "sed",
  },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: RG,
  jq: {
    firstIsProgram: true,
    programFlags: ["--from-file", "-f"],
    fileFlags: ["--from-file", "-f"],
    flags: ["-r", "-j", "-c", "-n", "-s", "-e", "-S", "-C", "-M", "-a", "-R", "--raw-output",
      "--join-output", "--compact-output", "--null-input", "--slurp", "--exit-status",
      "--sort-keys", "--color-output", "--monochrome-output", "--ascii-output", "--tab",
      "--seq", "--stream", "--raw-input", "--args", "--jsonargs", "-L"],
    valueFlags: ["--indent"],
    pairFlags: ["--arg", "--argjson"],
    pairFileFlags: ["--slurpfile", "--rawfile"],
    refuseFlags: ["--args", "--jsonargs", "-L"],
    programCheck: "jq",
  },
  diff: {
    flags: ["-u", "-c", "-q", "-s", "-r", "-N", "-a", "-b", "-w", "-B", "-i", "-y", "-e", "-n",
      "--brief", "--report-identical-files", "--recursive", "--new-file", "--text",
      "--ignore-space-change", "--ignore-all-space", "--ignore-blank-lines", "--ignore-case",
      "--side-by-side", "--normal"],
    valueFlags: ["-U", "-C", "-L", "--label", "--from-file", "--to-file"],
    fileFlags: ["--from-file", "--to-file"],
    optionalFlags: ["--unified", "--context"],
  },
  cmp: { flags: ["-l", "-s", "-b", "--verbose", "--silent", "--quiet"], valueFlags: ["-i", "-n"] },
  sha256sum: { flags: ["-b", "-t", "-z", "--binary", "--text", "--tag", "--zero", "-c", "--check"], refuseFlags: ["-c", "--check"] },
  sha1sum: { flags: ["-b", "-t", "-z", "--binary", "--text", "--tag", "--zero", "-c", "--check"], refuseFlags: ["-c", "--check"] },
  md5sum: { flags: ["-b", "-t", "-z", "--binary", "--text", "--tag", "--zero", "-c", "--check"], refuseFlags: ["-c", "--check"] },
  shasum: { flags: ["-b", "-t", "-0", "-p", "-c", "--check"], valueFlags: ["-a", "--algorithm"], refuseFlags: ["-c", "--check"] },
  md5: { flags: ["-q", "-r", "-n"] },
  sort: {
    flags: ["-r", "-n", "-u", "-f", "-b", "-d", "-i", "-M", "-h", "-V", "-g", "-R", "-s", "-c",
      "-m", "-z", "--reverse", "--numeric-sort", "--unique", "--ignore-case",
      "--human-numeric-sort", "--version-sort", "--general-numeric-sort", "--stable", "--merge",
      "-o", "--output", "--files0-from"],
    valueFlags: ["-k", "-t", "-S", "-T", "--key", "--field-separator", "--buffer-size",
      "--temporary-directory", "-o", "--output", "--files0-from"],
    refuseFlags: ["-o", "--output", "--files0-from"],
  },
  uniq: { flags: ["-c", "-d", "-u", "-i", "-D"], valueFlags: ["-f", "-s", "-w"], singleInput: true },
  cut: {
    flags: ["-s", "-n", "--complement", "--only-delimited"],
    valueFlags: ["-d", "-f", "-c", "-b", "--delimiter", "--fields", "--characters", "--bytes",
      "--output-delimiter"],
  },
  // util-linux >= 2.30 gives `-n` a value (table name) where BSD does not.
  column: { flags: ["-t", "-x"], valueFlags: ["-s", "-c", "-o"], ambiguousFlags: ["-n"] },
  awk: { firstIsProgram: true, programFlags: ["-f"], fileFlags: ["-f"], valueFlags: ["-F", "-v"], programCheck: "awk" },
  // xxd reads options as whole words (`-ps` is postscript mode, not -p -s).
  xxd: { flags: ["-p", "-u", "-e", "-i", "-b", "-r"], valueFlags: ["-l", "-s", "-c", "-g", "-o"], refuseFlags: ["-r"], singleInput: true, wholeWordOptions: true },
  od: { flags: ["-c", "-x", "-o", "-d", "-v", "-b"], valueFlags: ["-A", "-t", "-N", "-j"] },
  hexdump: { flags: ["-C", "-c", "-b", "-d", "-o", "-x", "-v"], valueFlags: ["-n", "-s", "-e"], fileFlags: ["-f"] },
  strings: { flags: ["-a"], valueFlags: ["-n", "-t"] },
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
const AWK_UNSAFE = /getline|system|ENVIRON|ARGV|ARGC|PROCINFO|>|\||close\s*\(|fflush|@include|@load/;
const JQ_UNSAFE = /\benv\b|\$ENV|input_filename|\bimport\b|\binclude\b|\binputs?\b|\bnow\b|\bdebug\b|\bstderr\b|\$__loc__|\$__prog_args\b|\bget_search_list\b|\bget_prog_origin\b|\bget_jq_origin\b|\bhave_decnum\b|\bhave_literal_numbers\b|\bbuiltins\b|\blocaltime\b|\bstrflocaltime\b|\bmktime\b|\bhalt_error\b|\binput_line_number\b/;

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
  /** An explicit `-` operand (read stdin). */
  dashOperand: boolean;
  /** An option outside the allowlist, or an ambiguous spaced value. */
  unknown: boolean;
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
  let dashOperand = false;
  let unknown = false;
  const has = (list: readonly string[] | undefined, f: string): boolean => !!list?.includes(f);
  const requiresValue = (f: string): boolean => has(spec.valueFlags, f) || has(spec.fileFlags, f);
  const known = (f: string): boolean =>
    has(spec.flags, f) ||
    requiresValue(f) ||
    has(spec.optionalFlags, f) ||
    has(spec.ambiguousFlags, f) ||
    has(spec.pairFlags, f) ||
    has(spec.pairFileFlags, f) ||
    has(spec.refuseFlags, f) ||
    has(spec.attachedOnlyFlags, f);
  const noteValue = (flag: string, value: Token | undefined): void => {
    const isFile = has(spec.fileFlags, flag);
    if (has(spec.programFlags, flag)) {
      programGiven = true;
      if (isFile) programFromFile = true;
      else if (value) programs.push(value);
    }
    if (value && isFile) optionFiles.push(value);
  };
  for (let i = 0; i < args.length && !unknown; i++) {
    const a = args[i]!;
    const t = a.text;
    if (endOfOptions || !t.startsWith("-") || t === "-") {
      if (t === "-") dashOperand = true;
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
      if (!known(name)) {
        unknown = true; // includes abbreviations: exact names only
        break;
      }
      flags.add(name);
      if (has(spec.pairFlags, name) || has(spec.pairFileFlags, name)) {
        if (eq !== -1) {
          unknown = true;
          break;
        }
        if (has(spec.pairFileFlags, name) && args[i + 2]) optionFiles.push(args[i + 2]!);
        i += 2;
        continue;
      }
      if (eq !== -1) {
        noteValue(name, { ...a, text: t.slice(eq + 1) });
      } else if (has(spec.ambiguousFlags, name)) {
        unknown = true;
        break;
      } else if (requiresValue(name)) {
        noteValue(name, args[i + 1]);
        i += 1;
      }
      continue;
    }
    if (spec.numericShort && /^-\d+$/.test(t)) continue; // head -20
    if (spec.wholeWordOptions && t.length > 2) {
      unknown = true; // `-ps`, `-postscript`: not a cluster we can split
      break;
    }
    // A short-option cluster: `-rn`, `-A3`, `-nf pats`, `-i.bak`.
    for (let k = 1; k < t.length; k++) {
      const flag = `-${t[k]}`;
      if (!known(flag)) {
        unknown = true;
        break;
      }
      flags.add(flag);
      if (has(spec.attachedOnlyFlags, flag)) break; // the rest is its value
      const attached = t.slice(k + 1);
      if (has(spec.ambiguousFlags, flag)) {
        if (!attached) unknown = true; // `-C 2`: GNU consumes it, BSD does not
        break;
      }
      if (requiresValue(flag)) {
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
  if (!unknown && spec.requireFlag && !flags.has(spec.requireFlag)) return null;
  const hasProgram = spec.firstIsProgram && !programGiven;
  if (hasProgram && positional[0]) programs.push(positional[0]);
  const operands = (hasProgram ? positional.slice(1) : positional).filter((f) => f.text !== "-");
  return { operands, optionFiles, flags, programs, programFromFile, dashOperand, unknown };
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

  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi]!;
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
        part.joinBefore === "|" ||
        listIsBackgrounded(parts, pi)
      ) {
        return null;
      }
      cwd = resolve(target.text);
      continue;
    }
    if (cmd === "set" && isQuietSet(args)) {
      continue; // `set -euo pipefail` changes failure handling, not output
    }
    if (cmd === "export" || cmd === "set" || cmd === "local") {
      complete = false; // may change the environment the next command sees
      continue;
    }
    if (CONSTANT.has(cmd)) {
      // `echo $HOME`, `echo *`, and printf's `%(…)T` time format all depend
      // on the environment, not on any file.
      if (args.some((a) => a.dynamic || (cmd === "printf" && a.text.includes("%(")))) {
        complete = false;
      }
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
    if (parsed.unknown) {
      // An option we cannot interpret: nothing about this invocation is
      // trusted, not even which words are files.
      complete = false;
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
    const readsStdin = parsed.operands.length === 0 || parsed.dashOperand;
    if (readsStdin) for (const input of part.inputs) add(input);
  }

  return { files: [...files], complete };
}

/** True when the and-or list containing parts[i] ends in `&`: the whole
 * list (and any `cd` in it) then runs in a background subshell, and nothing
 * after it sees the directory change. */
function listIsBackgrounded(parts: Stage[], i: number): boolean {
  for (let j = i; j < parts.length; j++) {
    const join = parts[j]!.joinAfter;
    if (join === "&&" || join === "||" || join === "|") continue;
    return join === "&";
  }
  return false;
}

/** `set -e`, `set -eu`, `set -euo pipefail`, `set +x`: no output. A bare
 * `set -o` (which PRINTS the option table) is not quiet. */
function isQuietSet(args: Token[]): boolean {
  if (args.length === 0) return false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (/^[-+][eux]+$/.test(t)) continue;
    if (/^[-+][eux]*o$/.test(t) && /^[a-z]+$/.test(args[i + 1]?.text ?? "")) {
      i++;
      continue;
    }
    return false;
  }
  return true;
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
