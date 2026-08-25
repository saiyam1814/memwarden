import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeManualFiles } from "../src/functions/remember.js";

const dirs: string[] = [];

function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "memwarden-remember-paths-")));
  dirs.push(dir);
  return dir;
}

function projectFile(): { project: string; absolute: string } {
  const project = tmp();
  mkdirSync(join(project, "src"), { recursive: true });
  const absolute = join(project, "src", "auth.ts");
  writeFileSync(absolute, "export const refreshMinutes = 15;\n");
  return { project, absolute };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeManualFiles", () => {
  it("rejects null bytes", () => {
    const project = tmp();
    expect(() => normalizeManualFiles(project, ["src/auth\0.ts"])).toThrow(
      "files must contain valid paths",
    );
  });

  it("rejects parent traversal and absolute paths outside the project", () => {
    const project = tmp();
    const outside = tmp();
    const outsideFile = join(outside, "secret.ts");
    writeFileSync(outsideFile, "export const secret = true;\n");

    expect(() => normalizeManualFiles(project, ["../secret.ts"])).toThrow(
      "file must be inside the current project",
    );
    expect(() => normalizeManualFiles(project, [outsideFile])).toThrow(
      "file must be inside the current project",
    );
  });

  it("accepts a relative in-project path", () => {
    const { project } = projectFile();
    expect(normalizeManualFiles(project, ["src/auth.ts"])).toEqual([
      "src/auth.ts",
    ]);
  });

  it("accepts an absolute in-project path and stores it project-relative", () => {
    const { project, absolute } = projectFile();
    expect(normalizeManualFiles(project, [absolute])).toEqual(["src/auth.ts"]);
  });

  it("normalizes equivalent paths and removes duplicates", () => {
    const { project, absolute } = projectFile();
    expect(
      normalizeManualFiles(project, [
        "src/auth.ts",
        "./src/auth.ts",
        "src/nested/../auth.ts",
        `  ${absolute}  `,
      ]),
    ).toEqual(["src/auth.ts"]);
  });

  it("rejects paths that escape through an in-project symlink when supported", () => {
    const project = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "secret.ts"), "export const secret = true;\n");
    const link = join(project, "escape");
    try {
      symlinkSync(outside, link, "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOSYS", "ENOTSUP"].includes(code ?? "")) return;
      throw err;
    }

    expect(() => normalizeManualFiles(project, ["escape/secret.ts"])).toThrow(
      "file must be inside the current project",
    );
    expect(() =>
      normalizeManualFiles(project, ["escape/not-yet-created.ts"]),
    ).toThrow("file must be inside the current project");
  });
});
