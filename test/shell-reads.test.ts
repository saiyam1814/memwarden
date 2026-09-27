//
// Shell-read provenance, parser level. A wrong "verified" is worse than a
// missing one, so most of these pin what must NOT count as a complete read.
// Every case in the "review findings" block reproduced a false `verified`
// (or a false stale) in an adversarial review of the first version.

import { describe, expect, it } from "vitest";
import {
  extractShellReads,
  isLocalShellTool,
  shellCommandOf,
} from "../src/functions/shell-reads.js";

const BASE = "/repo";
const HOME = "/home/me";
const TMP = "/var/folders/xy/T";
const reads = (cmd: string) => extractShellReads(cmd, BASE, { home: HOME, tmpdir: TMP });

describe("shell reads: plain viewers are complete evidence", () => {
  it.each([
    ["sed -n '1,60p' src/auth.ts", ["/repo/src/auth.ts"]],
    ["sed -ne '3p' a.ts", ["/repo/a.ts"]],
    ["sed -n -e '1p' -e '$p' a.ts", ["/repo/a.ts"]],
    ["cat README.md", ["/repo/README.md"]],
    ["/bin/cat README.md", ["/repo/README.md"]],
    ["head -n 50 a.ts b.ts", ["/repo/a.ts", "/repo/b.ts"]],
    ["head -20 a.ts", ["/repo/a.ts"]],
    ["tail -n20 logs/x.log", ["/repo/logs/x.log"]],
    ['grep -n "session start" src/hook.ts', ["/repo/src/hook.ts"]],
    ["grep -rn -e pattern -e other src/a.ts", ["/repo/src/a.ts"]],
    ["grep -A3 -m1 foo a.ts", ["/repo/a.ts"]],
    ["grep --color=always foo a.ts b.ts", ["/repo/a.ts", "/repo/b.ts"]],
    ["grep -f pats.txt a.ts", ["/repo/a.ts", "/repo/pats.txt"]],
    ["grep --file=pats.txt a.ts", ["/repo/a.ts", "/repo/pats.txt"]],
    ["grep -nf pats.txt a.ts", ["/repo/a.ts", "/repo/pats.txt"]],
    ["rg -n --glob '*.ts' needle src/a.ts", ["/repo/src/a.ts"]],
    ["wc -l src/state/oplog.ts", ["/repo/src/state/oplog.ts"]],
    ["wc -l < src/a.ts", ["/repo/src/a.ts"]],
    ["jq -r '.version' package.json", ["/repo/package.json"]],
    ["jq --tab . a.json b.json", ["/repo/a.json", "/repo/b.json"]],
    ["jq --arg v 1 '.x' a.json", ["/repo/a.json"]],
    ["jq --rawfile x b.txt '$x' a.json", ["/repo/a.json", "/repo/b.txt"]],
    ["diff a.txt b.txt", ["/repo/a.txt", "/repo/b.txt"]],
    ["sha256sum dist/x.tgz", ["/repo/dist/x.tgz"]],
    ["awk -F: '{print $1}' /etc/passwd", ["/etc/passwd"]],
    ["column -t a.txt b.txt", ["/repo/a.txt", "/repo/b.txt"]],
    ["cat ~/.zshrc", ["/home/me/.zshrc"]],
    ["nl -ba src/a.ts | sed -n '10,20p'", ["/repo/src/a.ts"]],
    ["cat a.ts | grep foo | head -5", ["/repo/a.ts"]],
    ["cd /other && sed -n 1,5p y.ts 2>/dev/null", ["/other/y.ts"]],
    ["echo '--- a'; cat a.ts; echo '--- b'; cat b.ts", ["/repo/a.ts", "/repo/b.ts"]],
    ["set -euo pipefail; cat a.ts", ["/repo/a.ts"]],
    ["sed -n '1,5p' 'app/[id]/page.tsx'", ["/repo/app/[id]/page.tsx"]],
    ["LC_ALL=C sort -u names.txt", ["/repo/names.txt"]],
    ["grep -c x a.ts 2>&1", ["/repo/a.ts"]],
    ["cat a.ts > /dev/null", ["/repo/a.ts"]],
    ["cat a.ts < b.ts", ["/repo/a.ts"]], // stdin is ignored when operands are given
  ])("%s", (cmd, files) => {
    expect(reads(cmd)).toEqual({ files, complete: true });
  });
});

describe("shell reads: evidence that cannot vouch for the whole output is incomplete", () => {
  it.each([
    ["npm test && cat src/a.ts", ["/repo/src/a.ts"]],
    ["cat src/*.ts", []],
    ['cat "$SP/out.txt"', []],
    ["sed -n '1,5p' app/[id]/page.tsx", []], // unquoted brackets are a glob
    ["sed -i 's/a/b/' a.ts", []],
    ["sed 's/a/b/' a.ts", []], // no -n
    ["tail -f server.log", []],
    ["sort -o out.txt in.txt", []],
    ["ls src", []],
    ["git show HEAD:src/a.ts", []],
    ["rg needle", []],
    ["grep -rn needle", []],
    ["cat a.ts > copy.ts", ["/repo/a.ts"]],
    ["cat a.ts | python3 -c 'import sys; print(1)'", ["/repo/a.ts"]],
    ["grep -l x a.ts | xargs cat", ["/repo/a.ts"]],
  ])("%s", (cmd, files) => {
    const r = reads(cmd);
    expect(r).not.toBeNull();
    expect(r!.complete).toBe(false);
    expect(r!.files).toEqual(files);
  });

  it("caps the number of files and marks the rest incomplete", () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`).join(" ");
    const r = reads(`cat ${many}`)!;
    expect(r.files).toHaveLength(16);
    expect(r.complete).toBe(false);
  });

  it("refuses to analyze very long command lines (the parse must stay cheap)", () => {
    const huge = `cat ${"x".repeat(9_000)}`;
    expect(reads(huge)).toBeNull();
  });
});

describe("shell reads: review findings (each once produced a false verified)", () => {
  it.each([
    // B1: brace expansion reads files that are not operands as written
    ["cat src/{a,b}.ts src/c.ts", ["/repo/src/c.ts"]],
    ["cat f{1..3}.txt", []],
    ["cat a.ts(N) b.ts", ["/repo/b.ts"]],
    // S1: embedded programs that read, write, or execute
    ["sed -n '1r b.ts' a.ts", ["/repo/a.ts"]],
    ["sed -n '/foo/p' a.ts", ["/repo/a.ts"]], // regex addresses are not in the safe grammar
    ["sed -n 's/a/b/ep' a.ts", ["/repo/a.ts"]],
    ["sed -n -f script.sed a.ts", ["/repo/a.ts", "/repo/script.sed"]],
    ["awk '{ while ((getline l < \"b.ts\") > 0) print l }' a.ts", ["/repo/a.ts"]],
    ["awk '{print > \"out\"}' a.ts", ["/repo/a.ts"]],
    ["jq -n 'env.HOME'", []],
    ["jq '$ENV.PATH' a.json", ["/repo/a.json"]],
    ["jq -L /lib 'import \"x\" as x; .' a.json", []], // -L is refused outright
    // S3: checksum --check reads the files listed inside
    ["sha256sum -c SUMS", []],
    ["shasum --check SUMS", []],
    // S4: constant commands with dynamic args depend on the environment
    ["echo $HOME; cat a.ts", ["/repo/a.ts"]],
    ["echo *; cat a.ts", ["/repo/a.ts"]],
    // S5: path-qualified or environment-altered commands could be anything
    ["./cat a.ts", []],
    ["node_modules/.bin/jq . a.json", []],
    ["PATH=./bin:$PATH cat a.ts", ["/repo/a.ts"]],
    ["GREP_OPTIONS=-f/etc/x grep foo a.ts", ["/repo/a.ts"]],
    // S9: temp files are never evidence
    ["cat /tmp/out.log", []],
    ["tail -n 5 /private/tmp/claude-501/x/tasks/b1.output", []],
    [`cat ${TMP}/scratch.txt`, []],
    // nits: `..` is resolved through symlinks by the kernel, not lexically
    ["cat ../other/x.ts", []],
    // nits: refuse checks survive clustering and attachment
    ["sed -n -Ei.bak '1p' a.ts", []],
    ["tail -fn5 x.log", []],
    ["sort -o/tmp/out in.txt", []],
    ["rg --pre ./decode foo a.ts", []],
    ["ag foo a.ts", []], // ag's flags differ from grep's; not a known viewer
    ["bat --diff a.ts", []],
    // nits: redirect targets are never operands; writes cap
    ["cat a.ts >&out.txt", ["/repo/a.ts"]],
    ["uniq in.txt out.txt", ["/repo/in.txt"]],
  ])("%s", (cmd, files) => {
    const r = reads(cmd);
    expect(r).not.toBeNull();
    expect(r!.complete).toBe(false);
    expect(r!.files).toEqual(files);
  });

  it("a project that itself lives in a temp dir still counts as the project", () => {
    const r = extractShellReads("cat src/a.ts", `${TMP}/repo`, { tmpdir: TMP });
    expect(r).toEqual({ files: [`${TMP}/repo/src/a.ts`], complete: true });
    const outside = extractShellReads(`cat ${TMP}/other.txt`, `${TMP}/repo`, { tmpdir: TMP });
    expect(outside).toEqual({ files: [], complete: false });
  });

  it.each([
    // N1: long options outside the allowlist (incl. GNU/BSD abbreviations)
    ["/usr/bin/grep --context x a.txt b.txt"],
    ["grep -C 2 foo a.txt"],
    ["sha256sum --ch SUMS"],
    ["shasum --chec SUMS"],
    ["sort --files0-from list0"],
    ["grep --reg=x a.txt b.txt"],
    ["sed -n 1p --expr='1r b.ts' a.ts"],
    ["awk --file=prog.awk a.ts b.ts"],
    ["awk -E prog.awk a.ts b.ts"],
    ["wc --files0-from list0"],
    ["sed -n --in-pl 1p a.ts"],
    ["sort --out=x a.txt"],
    ["tail --fo a.log"],
    ["cat --frobnicate a.ts"],
    // N2: awk swaps its input through ARGV
    ["awk 'BEGIN{ARGV[1]=\"b.txt\"} {print}' a.txt"],
    // nits: environment-dependent output
    ["jq -n 'get_search_list'"],
    ["jq 'now | localtime' a.json"],
    ["printf '%(%F)T\\n' -1; cat a.ts"],
    ["set -o; cat a.ts"],
    // round-3 nits
    ["sed -n -l 1p a.ts"],
    ["xxd -ps a.bin"],
    ["column -n name a.txt"],
    ["jq -n 'get_prog_origin'"],
  ])("never complete: %s", (cmd) => {
    const r = reads(cmd);
    expect(r === null || r.complete === false).toBe(true);
  });

  it("known optional/attached forms still work", () => {
    expect(reads("diff --unified=3 a.txt b.txt")).toEqual({ files: ["/repo/a.txt", "/repo/b.txt"], complete: true });
    // optional in GNU and Apple diff alike: the bare form consumes nothing (it used to eat a.txt)
    expect(reads("diff --unified a.txt b.txt")).toEqual({ files: ["/repo/a.txt", "/repo/b.txt"], complete: true });
    expect(reads("grep -C2 foo a.txt")).toEqual({ files: ["/repo/a.txt"], complete: true });
    expect(reads("grep --context=2 foo a.txt")).toEqual({ files: ["/repo/a.txt"], complete: true });
    expect(reads("grep --color foo a.txt b.txt")).toEqual({ files: ["/repo/a.txt", "/repo/b.txt"], complete: true });
  });

  it("N4: a newline after && / || / | continues the list; a backgrounded cd list yields nothing", () => {
    expect(reads("echo hi ||\ncd /abs && cat f.txt")).toBeNull();
    expect(reads("cd /abs && true & cat f.txt")).toBeNull();
    expect(reads("cat a.ts |\ngrep x")).toEqual({ files: ["/repo/a.ts"], complete: true });
  });

  it("nits: `00<` is stdin; `-` as an option value is not a stdin operand", () => {
    expect(reads("cat - 00<b.ts")).toEqual({ files: ["/repo/b.ts"], complete: true });
    expect(reads("cut -d - -f1 a.txt < b.txt")).toEqual({ files: ["/repo/a.txt"], complete: true });
  });

  it("an fd other than stdin is not the command's input", () => {
    expect(reads("cat 3<b.ts")).toEqual({ files: [], complete: true });
  });

  it("double quotes keep a backslash that escapes nothing; quoted tilde is literal", () => {
    expect(reads('cat "a\\b.ts"')!.files).toEqual(["/repo/a\\b.ts"]);
    expect(reads("cat '~/x'")!.files).toEqual(["/repo/~/x"]);
  });
});

describe("shell reads: unanalyzable commands yield no evidence at all", () => {
  it.each([
    "echo $(cat a.ts)",
    "cat `ls`",
    "diff <(sort a) <(sort b)",
    "python3 - <<'EOF'\nprint(1)\nEOF",
    "cat <<< hello",
    "cat 'unterminated",
    'grep "x $(whoami)" a.ts',
    // B3: a cd whose effect is not certain
    "cd $DIR && cat a.ts",
    "cd - && cat a.ts",
    "cd sub && cat x.ts",
    "cd .. && cat package.json",
    "cd /abs; cat x.ts",
    "true || cd /abs && cat x.ts",
    "cd /abs | true; cat x.ts",
    "cd ~/proj && cat x.ts",
  ])("%s", (cmd) => {
    expect(reads(cmd)).toBeNull();
  });
});

describe("shell tools and command shapes", () => {
  it("only a host's own local shell tool is parsed; generic and MCP names never are", () => {
    const yes: Array<[string, string | undefined]> = [
      ["Bash", "claude-code"], ["Bash", "codex"], ["exec_command", "codex"], ["local_shell", "codex"],
      ["run_shell_command", "gemini"], ["run_terminal_cmd", "cursor"], ["executeBash", "kiro"],
      ["bash", "opencode"], ["Bash", undefined],
    ];
    for (const [t, h] of yes) expect(isLocalShellTool(t, h)).toBe(true);
    const no: Array<[string | undefined, string | undefined]> = [
      ["exec", "gemini"], ["exec", undefined], ["shell", undefined], ["run_command", "claude-code"],
      ["mcp__ssh__exec", "codex"], ["mcp__kubernetes__exec_in_pod", "claude-code"], ["Read", "claude-code"],
      [undefined, "codex"], ["Bash", "some-new-host"],
    ];
    for (const [t, h] of no) expect(isLocalShellTool(t, h)).toBe(false);
  });

  it("reads a string, a Codex bash -lc argv, a `cmd` key, and quotes other argv verbatim", () => {
    expect(shellCommandOf({ command: "cat a.ts" })).toBe("cat a.ts");
    expect(shellCommandOf({ command: ["bash", "-lc", "sed -n 1,5p a.ts"] })).toBe("sed -n 1,5p a.ts");
    expect(shellCommandOf({ command: ["/bin/zsh", "-c", "cat b"] })).toBe("cat b");
    expect(shellCommandOf({ cmd: "cat c" })).toBe("cat c");
    expect(shellCommandOf({ command: ["cat", "my file.ts"] })).toBe("'cat' 'my file.ts'");
    // -c must be the shell's own flag, not a script's argument
    expect(shellCommandOf({ command: ["bash", "script.sh", "-c", "cat a.ts"] })).toBe(
      "'bash' 'script.sh' '-c' 'cat a.ts'",
    );
    expect(shellCommandOf({ query: "x" })).toBeUndefined();
  });

  it("an argv command's operands are never tilde-expanded (exec does not expand)", () => {
    const cmd = shellCommandOf({ command: ["cat", "~/x"] })!;
    expect(extractShellReads(cmd, BASE, { home: HOME })!.files).toEqual(["/repo/~/x"]);
  });
});
