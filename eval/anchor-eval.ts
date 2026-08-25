// Deterministic controlled corpus for #62. This intentionally measures only the
// bounded production slice: exact post-edit spans under unrelated, cosmetic,
// shifted, changed, and removed source. It has no model/parser variability.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFineGrainedEvidence } from "../src/functions/anchors.js";
import {
  classifyProvenance,
  hashFiles,
  hashFilesNormalized,
} from "../src/functions/verify.js";
import type { Provenance } from "../src/functions/types.js";

interface CorpusCase {
  id: string;
  captureContent: string;
  mutationContent: string;
  expectedCurrent: boolean;
}

function corpus(): CorpusCase[] {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("./anchor-corpus.json", import.meta.url), "utf8"),
  );
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as CorpusCase).id === "string" &&
        typeof (item as CorpusCase).captureContent === "string" &&
        typeof (item as CorpusCase).mutationContent === "string" &&
        typeof (item as CorpusCase).expectedCurrent === "boolean",
    )
  ) {
    throw new Error("invalid anchor evaluation corpus");
  }
  return parsed as CorpusCase[];
}

const root = mkdtempSync(join(tmpdir(), "memwarden-anchor-eval-"));
const path = "policy.ts";
try {
  const results = corpus().map((entry) => {
    writeFileSync(join(root, path), entry.captureContent, "utf8");
    const anchors = captureFineGrainedEvidence({
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput: {
        file_path: path,
        old_string: "export const TTL = 3600;",
        new_string: "export const TTL = 900;",
      },
      toolOutput: "ok",
      cwd: root,
      referencedFiles: [path],
      observationType: "file_edit",
    });
    if (!anchors || anchors.completeness !== "complete") {
      throw new Error(`corpus case did not capture a complete anchor: ${entry.id}`);
    }
    const provenance: Provenance = {
      cwd: root,
      files: [path],
      fileHashes: hashFiles([path], root),
      fileHashesNormalized: hashFilesNormalized([path], root),
      anchors,
    };
    const capturedWholeHash = provenance.fileHashes![path]!;
    writeFileSync(join(root, path), entry.mutationContent, "utf8");
    const wholeFileWouldBlock = hashFiles([path], root)[path] !== capturedWholeHash;
    const verdict = classifyProvenance(provenance, root);
    const fineGrainedCurrent =
      verdict.sourceStatus === "matched" && verdict.status !== "stale";
    return {
      id: entry.id,
      expectedCurrent: entry.expectedCurrent,
      wholeFileWouldBlock,
      fineGrainedCurrent,
      anchorStatus: verdict.fineGrained?.status ?? "missing",
    };
  });

  const valid = results.filter((entry) => entry.expectedCurrent);
  const invalid = results.filter((entry) => !entry.expectedCurrent);
  const report = {
    corpusCases: results.length,
    validCases: valid.length,
    invalidCases: invalid.length,
    wholeFileFalseBlocks: valid.filter((entry) => entry.wholeFileWouldBlock).length,
    fineGrainedFalseBlocks: valid.filter((entry) => !entry.fineGrainedCurrent).length,
    missedInvalidations: invalid.filter((entry) => entry.fineGrainedCurrent).length,
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.fineGrainedFalseBlocks !== 0 || report.missedInvalidations !== 0) {
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
