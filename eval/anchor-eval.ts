// Deterministic controlled corpus for #62. This intentionally measures only the
// bounded production slice: exact post-edit spans under unrelated, cosmetic,
// shifted, changed, and removed source. It has no model/parser variability.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureFineGrainedEvidence,
  fineGrainedClaimForObservation,
} from "../src/functions/anchors.js";
import {
  classifyProvenance,
  hashFileCommitments,
} from "../src/functions/verify.js";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";
import type { Provenance, RawObservation } from "../src/functions/types.js";

interface CorpusCase {
  id: string;
  captureContent: string;
  mutationContent: string;
  expectedCurrent: boolean;
  expectedCompleteness?: "complete" | "partial";
  toolOutput?: string;
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
        typeof (item as CorpusCase).expectedCurrent === "boolean" &&
        ((item as CorpusCase).toolOutput === undefined ||
          typeof (item as CorpusCase).toolOutput === "string") &&
        ((item as CorpusCase).expectedCompleteness === undefined ||
          ["complete", "partial"].includes(
            String((item as CorpusCase).expectedCompleteness),
          )),
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
    const toolInput = {
      file_path: path,
      old_string: "export const TTL = 3600;",
      new_string: "export const TTL = 900;",
    };
    const raw: RawObservation = {
      id: `obs_${entry.id}`,
      sessionId: "anchor-eval",
      timestamp: "2026-01-01T00:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput,
      toolOutput: entry.toolOutput ?? "ok",
      raw: {},
    };
    const observation = buildSyntheticCompression(raw);
    const { toolOutput: _hostOutput, ...operationOnlyRaw } = raw;
    const anchors = captureFineGrainedEvidence({
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput,
      toolOutput: entry.toolOutput ?? "ok",
      cwd: root,
      referencedFiles: [path],
      observation,
      operationOnlyObservation: buildSyntheticCompression(operationOnlyRaw),
    });
    if (!anchors) {
      throw new Error(`corpus case did not capture an anchor: ${entry.id}`);
    }
    const commitments = hashFileCommitments([path], root);
    const provenance: Provenance = {
      cwd: root,
      files: [path],
      fileHashes: commitments.fileHashes,
      fileHashesNormalized: commitments.fileHashesNormalized,
      anchors,
    };
    const capturedWholeHash = provenance.fileHashes![path]!;
    writeFileSync(join(root, path), entry.mutationContent, "utf8");
    const wholeFileWouldBlock =
      hashFileCommitments([path], root).fileHashes[path] !== capturedWholeHash;
    const verdict = classifyProvenance(provenance, root, {
      fineGrainedClaim: fineGrainedClaimForObservation(observation),
    });
    const fineGrainedCurrent =
      verdict.status === "verified" || verdict.status === "cosmetic";
    return {
      id: entry.id,
      expectedCurrent: entry.expectedCurrent,
      expectedCompleteness: entry.expectedCompleteness ?? "complete",
      wholeFileWouldBlock,
      fineGrainedCurrent,
      captureCompleteness: anchors.completeness,
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
    completenessMismatches: results.filter(
      (entry) => entry.captureCompleteness !== entry.expectedCompleteness,
    ).length,
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  if (
    report.fineGrainedFalseBlocks !== 0 ||
    report.missedInvalidations !== 0 ||
    report.completenessMismatches !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
