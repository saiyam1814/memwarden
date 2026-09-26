//
// Shell-read provenance, parser level. A wrong "verified" is worse than a
// missing one, so most of these pin what must NOT count as a complete read.

import { describe, expect, it } from "vitest";
import { extractShellReads, shellCommandOf } from "../src/functions/shell-reads.js";

const BASE = "/repo";
const HOME = "/home/me";
const reads = (cmd: string) => extractShellReads(cmd, BASE, HOME);

describe("shell reads: plain viewers are complete evidence", () => {
  it.each([
    ["sed -n '1,60p' src/auth.ts", ["/repo/src/auth.ts"]],
    ["cat README.md", ["/repo/README.md"]],
    ["head -n 50 a.ts b.ts", ["/repo/a.ts", "/repo/b.ts"]],
    ["head -20 a.ts", ["/repo/a.ts"]],
    ["tail -n20 logs/x.log", ["/repo/logs/x.log"]],
    ['grep -n "session start" src/hook.ts', ["/repo/src/hook.ts"]],
    ["grep -rn -e pattern -e other src/a.ts", ["/repo/src/a.ts"]],
    ["rg -n --glob '*.ts' needle src/a.ts", ["/repo/src/a.ts"]],
    ["wc -l src/state/oplog.ts", ["/repo/src/state/oplog.ts"]],
    ["wc -l < src/a.ts", ["/repo/src/a.ts"]],
    ["jq -r '.version' package.json", ["/repo/package.json"]],
    ["jq --arg v 1 '.x' a.json", ["/repo/a.json"]],
    ["diff a.txt b.txt", ["/repo/a.txt", "/repo/b.txt"]],
    ["sha256sum dist/x.tgz", ["/repo/dist/x.tgz"]],
    ["awk -F: '{print $1}' /etc/passwd", ["/etc/passwd"]],
    ["cat ~/.zshrc", ["/home/me/.zshrc"]],
    ["nl -ba src/a.ts | sed -n '10,20p'", ["/repo/src/a.ts"]],
    ["cat a.ts | grep foo | head -5", ["/repo/a.ts"]],
    ["cd sub && cat x.ts", ["/repo/sub/x.ts"]],
    ["cd /other && sed -n 1,5p y.ts 2>/dev/null", ["/other/y.ts"]],
    ["echo '--- a'; cat a.ts; echo '--- b'; cat b.ts", ["/repo/a.ts", "/repo/b.ts"]],
    ["sed -n '1,5p' 'app/[id]/page.tsx'", ["/repo/app/[id]/page.tsx"]],
    ["LC_ALL=C sort -u names.txt", ["/repo/names.txt"]],
    ["grep -c x a.ts 2>&1", ["/repo/a.ts"]],
    ["cat a.ts > /dev/null", ["/repo/a.ts"]],
    ["sed -ne '3p' a.ts", ["/repo/a.ts"]],
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
    ["sed 's/a/b/' a.ts", []], // no -n: prints every line, but also edits the stream
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
    "cd $DIR && cat a.ts",
    "cd - && cat a.ts",
  ])("%s", (cmd) => {
    expect(reads(cmd)).toBeNull();
  });
});

describe("shell command shapes hosts send", () => {
  it("reads a plain string and a Codex bash -lc argv", () => {
    expect(shellCommandOf({ command: "cat a.ts" })).toBe("cat a.ts");
    expect(shellCommandOf({ command: ["bash", "-lc", "sed -n 1,5p a.ts"] })).toBe("sed -n 1,5p a.ts");
    expect(shellCommandOf({ command: ["/bin/zsh", "-c", "cat b"] })).toBe("cat b");
    expect(shellCommandOf({ command: ["cat", "my file.ts"] })).toBe("cat 'my file.ts'");
    expect(shellCommandOf({ query: "x" })).toBeUndefined();
  });
});
