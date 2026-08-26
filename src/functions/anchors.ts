//
// Fine-grained evidence anchors (#62), deliberately limited to deterministic
// units already present in successful tool payloads. No source payload is
// retained: capture stores bounded locations plus raw/normalized commitments,
// and verification always reads and re-hashes the live checkout.
//

import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  CompressedObservation,
  FineGrainedAnchor,
  FineGrainedClaimCommitment,
  FineGrainedConfigLocation,
  FineGrainedContextSide,
  FineGrainedEvidence,
  FineGrainedInlineContextSide,
  FineGrainedTextContext,
  FineGrainedTextLocation,
  Memory,
} from "./types.js";
import {
  decodeUtf8,
  normalizedTextHash,
  readBoundedFileUnderRoot,
  sha256,
  SHA256_RE,
} from "./source-content.js";

export const FINE_GRAINED_EVIDENCE_FORMAT = 1;
export const MAX_FINE_GRAINED_ANCHORS = 16;
export const MAX_ANCHOR_FILE_BYTES = 1_000_000;
export const MAX_ANCHOR_CONTENT_BYTES = 128_000;
export const MAX_ANCHOR_LINES = 400;
export const MAX_ANCHOR_OCCURRENCES = 64;
export const MAX_ANCHOR_CONTEXT_LINES = 2;
export const MAX_ANCHOR_CONTEXT_BYTES = 32_000;
export const MAX_ANCHOR_INLINE_CONTEXT_BYTES = 64;
export const MAX_ANCHOR_NORMALIZED_CANDIDATES = 20_000;
const MAX_LOCATOR_COLLISIONS = 1_024;
const MAX_CANDIDATE_HASH_BYTES = 8_000_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_TOKENS = 20_000;
const LOCATOR_BASE = 257;
const UNSAFE_MAP_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface ByteLine {
  start: number;
  contentEnd: number;
  newlineEnd: number;
}

function byteLines(bytes: Uint8Array): ByteLine[] {
  const out: ByteLine[] = [];
  let start = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] !== 0x0a) continue;
    const contentEnd = i > start && bytes[i - 1] === 0x0d ? i - 1 : i;
    out.push({ start, contentEnd, newlineEnd: i + 1 });
    start = i + 1;
  }
  out.push({ start, contentEnd: bytes.byteLength, newlineEnd: bytes.byteLength });
  return out;
}

function lineIndexAt(lines: ByteLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const line = lines[mid]!;
    const next = lines[mid + 1];
    if (offset < line.start) high = mid - 1;
    else if (next && offset >= next.start) low = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(lines.length - 1, low));
}

function locationFor(
  bytes: Uint8Array,
  startByte: number,
  endByte: number,
  forceLineBoundaries = false,
): FineGrainedTextLocation | null {
  if (
    !Number.isInteger(startByte) ||
    !Number.isInteger(endByte) ||
    startByte < 0 ||
    endByte <= startByte ||
    endByte > bytes.byteLength
  ) {
    return null;
  }
  const lines = byteLines(bytes);
  const startIndex = lineIndexAt(lines, startByte);
  const endIndex = lineIndexAt(lines, endByte);
  const start = lines[startIndex]!;
  const end = lines[endIndex]!;
  const lineCount = endIndex - startIndex + 1;
  if (lineCount < 1 || lineCount > MAX_ANCHOR_LINES) return null;
  return {
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    startColumn: startByte - start.start,
    endColumn: endByte - end.start,
    startByte,
    endByte,
    byteLength: endByte - startByte,
    lineCount,
    startAtLineStart: forceLineBoundaries || startByte === start.start,
    endAtLineEnd: forceLineBoundaries || endByte === end.contentEnd,
  };
}

function logicalLineCount(lines: ByteLine[], bytes: Uint8Array): number {
  const last = lines[lines.length - 1];
  return lines.length > 1 && last?.start === bytes.byteLength
    ? lines.length - 1
    : lines.length;
}

function contextSide(
  bytes: Uint8Array,
  lines: ByteLine[],
  startLine: number,
  endLine: number,
  direction: "before" | "after",
): FineGrainedContextSide | null {
  const logicalCount = logicalLineCount(lines, bytes);
  let first: number;
  let last: number;
  let boundary: boolean;
  if (direction === "before") {
    last = startLine - 1;
    first = Math.max(0, last - MAX_ANCHOR_CONTEXT_LINES + 1);
    boundary = startLine === 0;
  } else {
    first = endLine + 1;
    last = Math.min(logicalCount - 1, first + MAX_ANCHOR_CONTEXT_LINES - 1);
    boundary = first >= logicalCount;
  }
  const lineCount = last >= first ? last - first + 1 : 0;
  const contextBytes =
    lineCount > 0
      ? bytes.subarray(lines[first]!.start, lines[last]!.contentEnd)
      : Buffer.alloc(0);
  if (contextBytes.byteLength > MAX_ANCHOR_CONTEXT_BYTES) return null;
  const normalizedHash = normalizedTextHash(contextBytes);
  if (!normalizedHash) return null;
  return {
    lineCount,
    rawHash: sha256(contextBytes),
    normalizedHash,
    boundary,
  };
}

function inlineContextSide(
  bytes: Uint8Array,
): FineGrainedInlineContextSide | null {
  const normalizedHash = normalizedTextHash(bytes);
  if (!normalizedHash) return null;
  return {
    byteLength: bytes.byteLength,
    rawHash: sha256(bytes),
    normalizedHash,
  };
}

function textContextFor(
  bytes: Uint8Array,
  location: FineGrainedTextLocation,
): FineGrainedTextContext | null {
  const lines = byteLines(bytes);
  const startLine = location.startLine - 1;
  const endLine = location.endLine - 1;
  const before = contextSide(bytes, lines, startLine, endLine, "before");
  const after = contextSide(bytes, lines, startLine, endLine, "after");
  const prefix = inlineContextSide(
    bytes.subarray(
      Math.max(
        lines[startLine]!.start,
        location.startByte - MAX_ANCHOR_INLINE_CONTEXT_BYTES,
      ),
      location.startByte,
    ),
  );
  const suffix = inlineContextSide(
    bytes.subarray(
      location.endByte,
      Math.min(
        lines[endLine]!.contentEnd,
        location.endByte + MAX_ANCHOR_INLINE_CONTEXT_BYTES,
      ),
    ),
  );
  return before && after && prefix && suffix
    ? {
        normalization: "text-lf-trailing-whitespace-v1",
        before,
        after,
        prefix,
        suffix,
      }
    : null;
}

function sortedStrings(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

/** Claim commitments bind actionable coverage to the exact claim representation
 * that is persisted at each layer. They are not signatures; Canon review remains
 * the authorship boundary, while import can detect content changed after capture. */
export function fineGrainedClaimForObservation(
  observation: Pick<
    CompressedObservation,
    | "type"
    | "title"
    | "subtitle"
    | "facts"
    | "narrative"
    | "concepts"
    | "files"
    | "imageDescription"
  >,
): FineGrainedClaimCommitment {
  return {
    schema: "synthetic-observation-v1",
    hash: sha256(
      JSON.stringify({
        type: observation.type,
        title: observation.title,
        subtitle: observation.subtitle ?? null,
        facts: [...(observation.facts ?? [])],
        narrative: observation.narrative,
        concepts: sortedStrings(observation.concepts),
        files: sortedStrings(observation.files),
        imageDescription: observation.imageDescription ?? null,
      }),
    ),
  };
}

export type FineGrainedMemoryClaim = Pick<
  Memory,
  "type" | "title" | "content" | "concepts" | "files"
> &
  Partial<Pick<Memory, "subtitle" | "facts" | "imageDescription">>;

export function fineGrainedClaimForMemory(
  memory: FineGrainedMemoryClaim,
): FineGrainedClaimCommitment {
  return {
    schema: "memory-claim-v1",
    hash: sha256(
      JSON.stringify({
        type: memory.type,
        title: memory.title,
        subtitle: memory.subtitle ?? null,
        content: memory.content,
        facts: [...(memory.facts ?? [memory.content])],
        concepts: sortedStrings(memory.concepts),
        files: sortedStrings(memory.files),
        imageDescription: memory.imageDescription ?? null,
      }),
    ),
  };
}

export type FineGrainedCanonClaim = Pick<
  Memory,
  "type" | "title" | "content" | "concepts" | "files"
>;

export function fineGrainedClaimForCanon(
  record: FineGrainedCanonClaim,
): FineGrainedClaimCommitment {
  return {
    schema: "canon-claim-v1",
    hash: sha256(
      JSON.stringify({
        type: record.type,
        title: record.title,
        content: record.content,
        concepts: sortedStrings(record.concepts),
        files: sortedStrings(record.files),
      }),
    ),
  };
}

function sameClaimCommitment(
  left: FineGrainedClaimCommitment,
  right: FineGrainedClaimCommitment,
): boolean {
  return left.schema === right.schema && left.hash === right.hash;
}

export function fineGrainedEvidenceMatchesClaim(
  evidence: unknown,
  claim: FineGrainedClaimCommitment | undefined,
): boolean {
  return (
    claim !== undefined &&
    isFineGrainedEvidence(evidence) &&
    sameClaimCommitment(evidence.claimCommitment, claim)
  );
}

function bindFineGrainedEvidenceToClaim(
  evidence: unknown,
  sourceClaim: FineGrainedClaimCommitment,
  claimCommitment: FineGrainedClaimCommitment,
): FineGrainedEvidence | null {
  const cloned = cloneFineGrainedEvidence(evidence);
  if (!cloned) return null;
  const sourceMatches = fineGrainedEvidenceMatchesClaim(cloned, sourceClaim);
  const wasClaimComplete =
    sourceMatches &&
    cloned.coverage.claim === "complete" &&
    cloned.claimCommitment.hash === cloned.supportHash;
  cloned.claimCommitment = claimCommitment;
  if (wasClaimComplete) cloned.supportHash = claimCommitment.hash;
  else if (!sourceMatches && cloned.supportHash === claimCommitment.hash) {
    cloned.supportHash = sha256(
      JSON.stringify(["claim-rebind-source-mismatch-v1", cloned.supportHash]),
    );
  }
  cloned.coverage.claim =
    cloned.claimCommitment.hash === cloned.supportHash ? "complete" : "partial";
  cloned.completeness = derivedCompleteness(cloned) ? "complete" : "partial";
  return isFineGrainedEvidence(cloned) ? cloned : null;
}

/** Rebind a distilled Memory to its full injected claim projection. */
export function bindFineGrainedEvidenceToMemory(
  evidence: unknown,
  memory: FineGrainedMemoryClaim,
  sourceClaim: FineGrainedClaimCommitment,
): FineGrainedEvidence | null {
  return bindFineGrainedEvidenceToClaim(
    evidence,
    sourceClaim,
    fineGrainedClaimForMemory(memory),
  );
}

/** Rebind a portable Canon record to only the claim fields Canon carries. */
export function bindFineGrainedEvidenceToCanon(
  evidence: unknown,
  record: FineGrainedCanonClaim,
  sourceClaim: FineGrainedClaimCommitment,
): FineGrainedEvidence | null {
  return bindFineGrainedEvidenceToClaim(
    evidence,
    sourceClaim,
    fineGrainedClaimForCanon(record),
  );
}

/** A portable anchor path has one checkout-relative meaning and cannot address
 * a parent directory or dangerous object-map key. */
export function isPortableAnchorPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f:*?"<>|]/.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return !parts.some(
    (part) =>
      !part ||
      part === "." ||
      part === ".." ||
      part.endsWith(".") ||
      part.endsWith(" ") ||
      UNSAFE_MAP_KEYS.has(part),
  );
}

function relativePathUnder(root: string, file: string): string | null {
  if (!root || !isAbsolute(root) || typeof file !== "string" || !file.trim()) {
    return null;
  }
  const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const rel = relative(root, absolute);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return null;
  }
  const portable = rel.split(sep).join("/");
  return isPortableAnchorPath(portable) ? portable : null;
}

function uint32Hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/** Rolling locator hashes are only an index into candidate windows. A locator
 * collision can at worst force an ambiguous fallback; SHA-256 decides matches. */
export function anchorLocatorHash(bytes: Uint8Array): string {
  let hash = 0;
  for (const byte of bytes) hash = (Math.imul(hash, LOCATOR_BASE) + byte) >>> 0;
  return uint32Hex(hash);
}

function countBytesOccurrences(
  haystack: Buffer,
  needle: Buffer,
): { count: number; capped: boolean; unique: boolean } {
  let count = 0;
  let from = 0;
  while (from <= haystack.byteLength - needle.byteLength) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count++;
    if (count > MAX_ANCHOR_OCCURRENCES) {
      return {
        count: MAX_ANCHOR_OCCURRENCES + 1,
        capped: true,
        unique: false,
      };
    }
    from = at + 1;
  }
  return { count, capped: false, unique: count === 1 };
}

function sourceCoverage(
  cwd: string,
  referencedFiles: readonly string[] | undefined,
  anchorPaths: readonly string[],
  mixedTrust: boolean,
): "complete" | "partial" {
  if (mixedTrust || !referencedFiles || referencedFiles.length === 0) {
    return "partial";
  }
  const normalized = new Set<string>();
  for (const file of referencedFiles) {
    const rel = relativePathUnder(cwd, file);
    if (!rel) return "partial";
    normalized.add(rel);
  }
  const anchored = new Set(anchorPaths);
  return normalized.size === anchored.size && [...normalized].every((p) => anchored.has(p))
    ? "complete"
    : "partial";
}

function derivedCompleteness(
  evidence: Pick<
    FineGrainedEvidence,
    "anchors" | "claimCommitment" | "supportHash" | "coverage"
  >,
): boolean {
  return (
    evidence.anchors.length > 0 &&
    evidence.coverage.claim === "complete" &&
    evidence.coverage.sources === "complete" &&
    evidence.claimCommitment.hash === evidence.supportHash &&
    evidence.anchors.every(
      (anchor) =>
        anchor.contentCompleteness === "complete" &&
        anchor.occurrence.unique &&
        !anchor.occurrence.capped &&
        anchor.occurrence.count === 1,
    )
  );
}

function evidenceFor(
  anchors: FineGrainedAnchor[],
  sources: "complete" | "partial",
  observation: CompressedObservation,
  supportObservation: CompressedObservation,
  operationSupportsClaim: boolean,
): FineGrainedEvidence {
  const claimCommitment = fineGrainedClaimForObservation(observation);
  const supportedProjectionHash =
    fineGrainedClaimForObservation(supportObservation).hash;
  // Keep an explicit cryptographic mismatch when operation structure itself is
  // unsupported, even if the unsupported fields happened not to render into
  // the compressed claim. A caller cannot upgrade it by flipping two enums.
  const supportHash = operationSupportsClaim
    ? supportedProjectionHash
    : sha256(JSON.stringify(["unsupported-operation-v1", supportedProjectionHash]));
  const claim =
    operationSupportsClaim && claimCommitment.hash === supportHash
      ? "complete"
      : "partial";
  const evidence: FineGrainedEvidence = {
    format: FINE_GRAINED_EVIDENCE_FORMAT,
    claimCommitment,
    supportHash,
    coverage: { claim, sources },
    completeness: "partial",
    anchors,
  };
  evidence.completeness = derivedCompleteness(evidence) ? "complete" : "partial";
  return evidence;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const FILE_INPUT_KEYS = ["file_path", "filePath", "path", "file"] as const;

function explicitFile(input: Record<string, unknown>): string | null {
  const values = FILE_INPUT_KEYS
    .map((key) => input[key])
    .filter((value): value is string => typeof value === "string" && !!value.trim());
  return new Set(values).size === 1 ? values[0]!.trim() : null;
}

function hasOnlyOperationKeys(
  input: Record<string, unknown>,
  operationKeys: readonly string[],
): boolean {
  const allowed = new Set<string>([...FILE_INPUT_KEYS, ...operationKeys]);
  return Object.keys(input).every((key) => allowed.has(key));
}

function normalizedToolName(value: string | undefined): string {
  return (value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function toolLooksLike(name: string | undefined, words: readonly string[]): boolean {
  const normalized = normalizedToolName(name);
  return words.some(
    (word) =>
      normalized === word ||
      normalized.startsWith(`${word}_`) ||
      normalized.endsWith(`_${word}`) ||
      normalized.includes(`_${word}_`) ||
      normalized.startsWith(word) ||
      normalized.endsWith(word),
  );
}

function readAnchorFile(
  cwd: string,
  file: string,
): { path: string; bytes: Buffer } | null {
  const path = relativePathUnder(cwd, file);
  if (!path) return null;
  const read = readBoundedFileUnderRoot(cwd, path, MAX_ANCHOR_FILE_BYTES);
  if (!read.ok || decodeUtf8(read.bytes) === null) return null;
  return { path, bytes: read.bytes };
}

function smallFileText(path: string, maxBytes: number): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    const value = readFileSync(path, "utf8");
    return Buffer.byteLength(value) <= maxBytes ? value : null;
  } catch {
    return null;
  }
}

function gitEntry(start: string): { root: string; entry: string } | null {
  let dir: string;
  try {
    dir = realpathSync(start);
  } catch {
    return null;
  }
  for (;;) {
    const entry = join(dir, ".git");
    if (existsSync(entry)) return { root: dir, entry };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Best-effort, no-child-process capture of the current git commit, including
 * linked worktrees. Unknown or malformed repository metadata simply omits it. */
export function sourceCommitAt(cwd: string): string | undefined {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  const found = gitEntry(cwd);
  if (!found) return undefined;
  let gitDir = found.entry;
  try {
    if (!statSync(gitDir).isDirectory()) {
      const pointer = smallFileText(gitDir, 4_096);
      const match = pointer ? /^gitdir:\s*(.+?)\s*$/m.exec(pointer) : null;
      if (!match) return undefined;
      gitDir = isAbsolute(match[1]!)
        ? resolve(match[1]!)
        : resolve(found.root, match[1]!);
    }
  } catch {
    return undefined;
  }

  const commonPointer = smallFileText(join(gitDir, "commondir"), 4_096)?.trim();
  const commonDir = commonPointer
    ? isAbsolute(commonPointer)
      ? resolve(commonPointer)
      : resolve(gitDir, commonPointer)
    : gitDir;
  const head = smallFileText(join(gitDir, "HEAD"), 4_096)?.trim();
  if (!head) return undefined;
  if (/^[a-f0-9]{40,64}$/i.test(head)) return head.toLowerCase();
  const refMatch = /^ref:\s*(refs\/[A-Za-z0-9._\/-]+)$/.exec(head);
  const ref = refMatch?.[1];
  if (!ref || ref.split("/").some((part) => part === "." || part === "..")) {
    return undefined;
  }
  for (const base of [gitDir, commonDir]) {
    const loose = smallFileText(join(base, ...ref.split("/")), 4_096)?.trim();
    if (loose && /^[a-f0-9]{40,64}$/i.test(loose)) return loose.toLowerCase();
  }
  const packed = smallFileText(join(commonDir, "packed-refs"), 2_000_000);
  if (!packed) return undefined;
  for (const line of packed.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space < 1 || line.slice(space + 1).trim() !== ref) continue;
    const hash = line.slice(0, space);
    if (/^[a-f0-9]{40,64}$/i.test(hash)) return hash.toLowerCase();
  }
  return undefined;
}

function baseAnchor(
  kind: "edit_span" | "line_range",
  path: string,
  bytes: Buffer,
  location: FineGrainedTextLocation,
  occurrence: { count: number; capped: boolean; unique: boolean },
  sourceCommit: string | undefined,
): FineGrainedAnchor | null {
  const content = bytes.subarray(location.startByte, location.endByte);
  const normalizedHash = normalizedTextHash(content);
  const context = textContextFor(bytes, location);
  if (!normalizedHash || !context) return null;
  return {
    kind,
    path,
    rawHash: sha256(content),
    normalizedHash,
    normalization: "text-lf-trailing-whitespace-v1",
    locatorHash: anchorLocatorHash(content),
    occurrence,
    contentCompleteness: "complete",
    ...(sourceCommit ? { sourceCommit } : {}),
    location,
    context,
  };
}

interface JsonSpan {
  pairStart: number;
  valueStart: number;
  valueEnd: number;
  pairEnd: number;
  value: unknown;
}

class JsonScanner {
  private position = 0;
  private tokens = 0;

  constructor(private readonly text: string) {}

  private bump(): void {
    this.tokens++;
    if (this.tokens > MAX_JSON_TOKENS) throw new Error("JSON token cap exceeded");
  }

  private whitespace(): void {
    while (/\s/.test(this.text[this.position] ?? "")) this.position++;
  }

  private stringToken(): { value: string; start: number; end: number } {
    this.bump();
    const start = this.position;
    if (this.text[this.position] !== '"') throw new Error("expected JSON string");
    this.position++;
    let escaped = false;
    while (this.position < this.text.length) {
      const char = this.text[this.position]!;
      this.position++;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        const end = this.position;
        const value: unknown = JSON.parse(this.text.slice(start, end));
        if (typeof value !== "string") throw new Error("invalid JSON key");
        return { value, start, end };
      }
    }
    throw new Error("unterminated JSON string");
  }

  private value(depth: number): number {
    if (depth > MAX_JSON_DEPTH) throw new Error("JSON depth cap exceeded");
    this.whitespace();
    this.bump();
    const start = this.position;
    const char = this.text[this.position];
    if (char === '"') {
      this.stringToken();
      return this.position;
    }
    if (char === "{") {
      this.position++;
      this.whitespace();
      if (this.text[this.position] === "}") return ++this.position;
      for (;;) {
        this.stringToken();
        this.whitespace();
        if (this.text[this.position++] !== ":") throw new Error("expected colon");
        this.value(depth + 1);
        this.whitespace();
        const separator = this.text[this.position++];
        if (separator === "}") return this.position;
        if (separator !== ",") throw new Error("expected object separator");
        this.whitespace();
      }
    }
    if (char === "[") {
      this.position++;
      this.whitespace();
      if (this.text[this.position] === "]") return ++this.position;
      for (;;) {
        this.value(depth + 1);
        this.whitespace();
        const separator = this.text[this.position++];
        if (separator === "]") return this.position;
        if (separator !== ",") throw new Error("expected array separator");
        this.whitespace();
      }
    }
    while (
      this.position < this.text.length &&
      !/[\s,}\]]/.test(this.text[this.position]!)
    ) {
      this.position++;
    }
    if (this.position === start) throw new Error("missing JSON value");
    JSON.parse(this.text.slice(start, this.position));
    return this.position;
  }

  topLevel(key: string): JsonSpan[] {
    this.whitespace();
    if (this.text[this.position++] !== "{") throw new Error("root is not object");
    this.whitespace();
    const matches: JsonSpan[] = [];
    if (this.text[this.position] === "}") {
      this.position++;
    } else {
      for (;;) {
        const property = this.stringToken();
        this.whitespace();
        if (this.text[this.position++] !== ":") throw new Error("expected colon");
        this.whitespace();
        const valueStart = this.position;
        const valueEnd = this.value(1);
        if (property.value === key) {
          matches.push({
            pairStart: property.start,
            valueStart,
            valueEnd,
            pairEnd: valueEnd,
            value: JSON.parse(this.text.slice(valueStart, valueEnd)),
          });
        }
        this.whitespace();
        const separator = this.text[this.position++];
        if (separator === "}") break;
        if (separator !== ",") throw new Error("expected root separator");
        this.whitespace();
      }
    }
    this.whitespace();
    if (this.position !== this.text.length) throw new Error("trailing JSON data");
    return matches;
  }
}

function jsonSpans(text: string, key: string): JsonSpan[] | null {
  try {
    // Let the platform parser establish strict JSON syntax; the bounded scanner
    // exists only to retain exact spans and detect duplicate decoded keys that
    // JSON.parse would otherwise collapse to the last value.
    JSON.parse(text);
    return new JsonScanner(text).topLevel(key);
  } catch {
    return null;
  }
}

function canonicalJson(
  value: unknown,
  state = { nodes: 0 },
  depth = 0,
): string | null {
  state.nodes++;
  if (state.nodes > MAX_JSON_TOKENS || depth > MAX_JSON_DEPTH) return null;
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : null;
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const encoded = canonicalJson(item, state, depth + 1);
      if (encoded === null) return null;
      items.push(encoded);
    }
    return `[${items.join(",")}]`;
  }
  const object = objectValue(value);
  if (!object) return null;
  const entries: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const encoded = canonicalJson(object[key], state, depth + 1);
    if (encoded === null) return null;
    entries.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${entries.join(",")}}`;
}

function canonicalConfigValue(key: string, value: unknown): string | null {
  const encoded = canonicalJson(value);
  return encoded === null ? null : `[${JSON.stringify(key)},${encoded}]`;
}

function captureEditAnchor(
  input: CaptureFineGrainedEvidenceInput,
  toolInput: Record<string, unknown>,
): FineGrainedEvidence | null {
  if (
    input.hookType !== "post_tool_use" ||
    input.observation.type !== "file_edit" ||
    input.operationOnlyObservation.type !== "file_edit" ||
    !toolLooksLike(input.toolName, ["edit", "replace", "patch"])
  ) {
    return null;
  }
  const oldString = toolInput["old_string"];
  const newString = toolInput["new_string"];
  const file = explicitFile(toolInput);
  if (
    typeof oldString !== "string" ||
    oldString.length === 0 ||
    oldString.length > MAX_ANCHOR_CONTENT_BYTES ||
    typeof newString !== "string" ||
    newString.length === 0 ||
    newString.length > MAX_ANCHOR_CONTENT_BYTES ||
    !file
  ) {
    return null;
  }
  const needle = Buffer.from(newString, "utf8");
  if (
    needle.byteLength === 0 ||
    needle.byteLength > MAX_ANCHOR_CONTENT_BYTES
  ) {
    return null;
  }
  const source = readAnchorFile(input.cwd, file);
  if (!source) return null;
  const occurrence = countBytesOccurrences(source.bytes, needle);
  // A post-edit string that is absent or non-unique cannot identify a source
  // unit deterministically. Keep the existing whole-file commitment instead.
  if (!occurrence.unique) return null;
  const at = source.bytes.indexOf(needle);
  const location = locationFor(source.bytes, at, at + needle.byteLength);
  if (!location) return null;
  const anchor = baseAnchor(
    "edit_span",
    source.path,
    source.bytes,
    location,
    occurrence,
    sourceCommitAt(input.cwd),
  );
  if (!anchor) return null;
  const sources = sourceCoverage(
    input.cwd,
    input.referencedFiles,
    [source.path],
    input.mixedTrust === true,
  );
  return evidenceFor(
    [anchor],
    sources,
    input.observation,
    input.operationOnlyObservation,
    hasOnlyOperationKeys(toolInput, [
      "old_string",
      "new_string",
      "replace_all",
    ]),
  );
}

function explicitLineRange(
  input: Record<string, unknown>,
): { start: number; end: number } | null {
  const start = input["start_line"] ?? input["startLine"] ?? input["line_start"];
  const end = input["end_line"] ?? input["endLine"] ?? input["line_end"];
  const hasExplicit = start !== undefined || end !== undefined;
  const offset = input["offset"];
  const limit = input["limit"];
  const hasOffset = offset !== undefined || limit !== undefined;
  if (hasExplicit && hasOffset) return null;
  let first: unknown;
  let last: unknown;
  if (hasExplicit) {
    first = start;
    last = end;
  } else if (hasOffset) {
    first = offset;
    last =
      typeof offset === "number" && typeof limit === "number"
        ? offset + limit - 1
        : undefined;
  } else {
    return null;
  }
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    (first as number) < 1 ||
    (last as number) < (first as number) ||
    (last as number) - (first as number) + 1 > MAX_ANCHOR_LINES
  ) {
    return null;
  }
  return { start: first as number, end: last as number };
}

function outputContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  const object = objectValue(value);
  return object &&
    typeof object["content"] === "string" &&
    Object.keys(object).every((key) => key === "content")
    ? (object["content"] as string)
    : null;
}

function captureLineRangeAnchor(
  input: CaptureFineGrainedEvidenceInput,
  toolInput: Record<string, unknown>,
): FineGrainedEvidence | null {
  if (
    input.hookType !== "post_tool_use" ||
    input.observation.type !== "file_read" ||
    !toolLooksLike(input.toolName, ["read", "view"])
  ) {
    return null;
  }
  const range = explicitLineRange(toolInput);
  const file = explicitFile(toolInput);
  if (!range || !file) return null;
  const source = readAnchorFile(input.cwd, file);
  if (!source) return null;
  const lines = byteLines(source.bytes);
  if (range.end > lines.length) return null;
  const first = lines[range.start - 1]!;
  const last = lines[range.end - 1]!;
  const startByte = first.start;
  const endByte = last.contentEnd;
  if (
    endByte <= startByte ||
    endByte - startByte > MAX_ANCHOR_CONTENT_BYTES
  ) {
    return null;
  }
  const location = locationFor(source.bytes, startByte, endByte, true);
  if (!location) return null;
  const selected = source.bytes.subarray(startByte, endByte);
  const occurrence = countBytesOccurrences(source.bytes, selected);
  const anchor = baseAnchor(
    "line_range",
    source.path,
    source.bytes,
    location,
    occurrence,
    sourceCommitAt(input.cwd),
  );
  if (!anchor) return null;
  const selectedText = decodeUtf8(selected);
  const operationSupportsClaim =
    selectedText !== null &&
    outputContent(input.toolOutput) === selectedText &&
    hasOnlyOperationKeys(toolInput, [
      "start_line",
      "startLine",
      "line_start",
      "end_line",
      "endLine",
      "line_end",
      "offset",
      "limit",
    ]);
  const sources = sourceCoverage(
    input.cwd,
    input.referencedFiles,
    [source.path],
    input.mixedTrust === true,
  );
  return evidenceFor(
    [anchor],
    sources,
    input.observation,
    operationSupportsClaim ? input.observation : input.operationOnlyObservation,
    operationSupportsClaim,
  );
}

function captureConfigAnchor(
  input: CaptureFineGrainedEvidenceInput,
  toolInput: Record<string, unknown>,
): FineGrainedEvidence | null {
  if (input.hookType !== "post_tool_use") return null;
  const key = toolInput["config_key"] ?? toolInput["configKey"];
  const file = explicitFile(toolInput);
  if (
    typeof key !== "string" ||
    !key ||
    key.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    !file ||
    !file.toLowerCase().endsWith(".json")
  ) {
    return null;
  }
  const source = readAnchorFile(input.cwd, file);
  if (!source) return null;
  const text = decodeUtf8(source.bytes);
  if (text === null) return null;
  const spans = jsonSpans(text, key);
  if (!spans || spans.length !== 1) return null;
  const span = spans[0]!;
  const rawPair = text.slice(span.pairStart, span.pairEnd);
  const rawBytes = Buffer.from(rawPair, "utf8");
  if (
    rawBytes.byteLength === 0 ||
    rawBytes.byteLength > MAX_ANCHOR_CONTENT_BYTES
  ) {
    return null;
  }
  const startByte = Buffer.byteLength(text.slice(0, span.pairStart));
  const endByte = startByte + rawBytes.byteLength;
  const baseLocation = locationFor(source.bytes, startByte, endByte);
  const normalized = canonicalConfigValue(key, span.value);
  if (!baseLocation || normalized === null) return null;
  const location: FineGrainedConfigLocation = {
    ...baseLocation,
    keyPath: [key],
  };
  const occurrence = { count: 1, capped: false, unique: true };
  const sourceCommit = sourceCommitAt(input.cwd);
  const anchor: FineGrainedAnchor = {
    kind: "json_config_value",
    path: source.path,
    rawHash: sha256(rawBytes),
    normalizedHash: sha256(normalized),
    normalization: "json-canonical-value-v1",
    locatorHash: anchorLocatorHash(rawBytes),
    occurrence,
    contentCompleteness: "complete",
    ...(sourceCommit ? { sourceCommit } : {}),
    location,
  };
  const supplied = Object.hasOwn(toolInput, "config_value")
    ? toolInput["config_value"]
    : Object.hasOwn(toolInput, "value")
      ? toolInput["value"]
      : undefined;
  const suppliedCanonical = canonicalConfigValue(key, supplied);
  const operationSupportsClaim =
    supplied !== undefined &&
    suppliedCanonical === normalized &&
    hasOnlyOperationKeys(toolInput, [
      "config_key",
      "configKey",
      "config_value",
      "value",
    ]);
  const sources = sourceCoverage(
    input.cwd,
    input.referencedFiles,
    [source.path],
    input.mixedTrust === true,
  );
  return evidenceFor(
    [anchor],
    sources,
    input.observation,
    input.operationOnlyObservation,
    operationSupportsClaim,
  );
}

export interface CaptureFineGrainedEvidenceInput {
  hookType: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  cwd: string;
  referencedFiles?: string[];
  mixedTrust?: boolean;
  /** The exact synthetic object that will be persisted. */
  observation: CompressedObservation;
  /** The same deterministic compression with host output removed. This binds
   * completeness to what the anchored operation itself supports. */
  operationOnlyObservation: CompressedObservation;
}

/** Capture only anchors whose exact live source bytes can be located after a
 * successful tool event. Command/test output intentionally has no path here. */
export function captureFineGrainedEvidence(
  input: CaptureFineGrainedEvidenceInput,
): FineGrainedEvidence | undefined {
  if (!input.cwd || !isAbsolute(input.cwd)) return undefined;
  const toolInput = objectValue(input.toolInput);
  if (!toolInput) return undefined;
  try {
    const config = captureConfigAnchor(input, toolInput);
    if (config) return config;
    const edit = captureEditAnchor(input, toolInput);
    if (edit) return edit;
    const range = captureLineRangeAnchor(input, toolInput);
    return range ?? undefined;
  } catch {
    // Anchor capture is an additive best-effort path. Malformed host payloads,
    // racing files, or hostile object shapes must never break observation.
    return undefined;
  }
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isTextLocation(value: unknown): value is FineGrainedTextLocation {
  const location = objectValue(value);
  if (!location) return false;
  if (
    !isIntegerIn(location["startLine"], 1, 10_000_000) ||
    !isIntegerIn(location["endLine"], 1, 10_000_000) ||
    (location["endLine"] as number) < (location["startLine"] as number) ||
    !isIntegerIn(location["startColumn"], 0, MAX_ANCHOR_FILE_BYTES) ||
    !isIntegerIn(location["endColumn"], 0, MAX_ANCHOR_FILE_BYTES) ||
    !isIntegerIn(location["startByte"], 0, MAX_ANCHOR_FILE_BYTES) ||
    !isIntegerIn(location["endByte"], 1, MAX_ANCHOR_FILE_BYTES) ||
    !isIntegerIn(location["byteLength"], 1, MAX_ANCHOR_CONTENT_BYTES) ||
    !isIntegerIn(location["lineCount"], 1, MAX_ANCHOR_LINES) ||
    location["startAtLineStart"] !== true &&
      location["startAtLineStart"] !== false
  ) {
    return false;
  }
  if (location["endAtLineEnd"] !== true && location["endAtLineEnd"] !== false) {
    return false;
  }
  return (
    (location["endByte"] as number) > (location["startByte"] as number) &&
    (location["endByte"] as number) - (location["startByte"] as number) ===
      location["byteLength"] &&
    (location["endLine"] as number) - (location["startLine"] as number) + 1 ===
      location["lineCount"]
  );
}

function isContextSide(value: unknown): value is FineGrainedContextSide {
  const side = objectValue(value);
  return (
    !!side &&
    isIntegerIn(side["lineCount"], 0, MAX_ANCHOR_CONTEXT_LINES) &&
    typeof side["rawHash"] === "string" &&
    SHA256_RE.test(side["rawHash"] as string) &&
    typeof side["normalizedHash"] === "string" &&
    SHA256_RE.test(side["normalizedHash"] as string) &&
    typeof side["boundary"] === "boolean" &&
    side["boundary"] === (side["lineCount"] === 0)
  );
}

function isInlineContextSide(
  value: unknown,
): value is FineGrainedInlineContextSide {
  const side = objectValue(value);
  return (
    !!side &&
    isIntegerIn(side["byteLength"], 0, MAX_ANCHOR_INLINE_CONTEXT_BYTES) &&
    typeof side["rawHash"] === "string" &&
    SHA256_RE.test(side["rawHash"] as string) &&
    typeof side["normalizedHash"] === "string" &&
    SHA256_RE.test(side["normalizedHash"] as string)
  );
}

function isTextContext(value: unknown): value is FineGrainedTextContext {
  const context = objectValue(value);
  return (
    !!context &&
    context["normalization"] === "text-lf-trailing-whitespace-v1" &&
    isContextSide(context["before"]) &&
    isContextSide(context["after"]) &&
    isInlineContextSide(context["prefix"]) &&
    isInlineContextSide(context["suffix"])
  );
}

function isOccurrence(value: unknown): boolean {
  const occurrence = objectValue(value);
  if (!occurrence) return false;
  if (
    !isIntegerIn(occurrence["count"], 1, MAX_ANCHOR_OCCURRENCES + 1) ||
    typeof occurrence["capped"] !== "boolean" ||
    typeof occurrence["unique"] !== "boolean"
  ) {
    return false;
  }
  const expectedUnique = occurrence["count"] === 1 && occurrence["capped"] === false;
  if (occurrence["unique"] !== expectedUnique) return false;
  return occurrence["capped"] === (occurrence["count"] === MAX_ANCHOR_OCCURRENCES + 1);
}

function isAnchor(value: unknown): value is FineGrainedAnchor {
  const anchor = objectValue(value);
  if (!anchor) return false;
  if (
    !["edit_span", "line_range", "json_config_value"].includes(
      String(anchor["kind"]),
    ) ||
    !isPortableAnchorPath(anchor["path"]) ||
    typeof anchor["rawHash"] !== "string" ||
    !SHA256_RE.test(anchor["rawHash"] as string) ||
    typeof anchor["normalizedHash"] !== "string" ||
    !SHA256_RE.test(anchor["normalizedHash"] as string) ||
    typeof anchor["locatorHash"] !== "string" ||
    !/^[a-f0-9]{8}$/.test(anchor["locatorHash"] as string) ||
    anchor["contentCompleteness"] !== "complete" ||
    !isOccurrence(anchor["occurrence"]) ||
    !isTextLocation(anchor["location"])
  ) {
    return false;
  }
  if (
    anchor["sourceCommit"] !== undefined &&
    (typeof anchor["sourceCommit"] !== "string" ||
      !/^[a-f0-9]{40,64}$/.test(anchor["sourceCommit"] as string))
  ) {
    return false;
  }
  if (anchor["kind"] === "json_config_value") {
    if (anchor["normalization"] !== "json-canonical-value-v1") return false;
    const location = anchor["location"] as unknown as Record<string, unknown>;
    return (
      Array.isArray(location["keyPath"]) &&
      location["keyPath"].length === 1 &&
      typeof location["keyPath"][0] === "string" &&
      location["keyPath"][0].length > 0 &&
      location["keyPath"][0].length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(location["keyPath"][0])
    );
  }
  return (
    anchor["normalization"] === "text-lf-trailing-whitespace-v1" &&
    isTextContext(anchor["context"])
  );
}

/** Strict validation of every trust-bearing field. Unknown additive fields are
 * ignored, and cloneFineGrainedEvidence drops them at import boundaries. */
export function isFineGrainedEvidence(
  value: unknown,
): value is FineGrainedEvidence {
  const evidence = objectValue(value);
  if (!evidence || evidence["format"] !== FINE_GRAINED_EVIDENCE_FORMAT) return false;
  const coverage = objectValue(evidence["coverage"]);
  const claimCommitment = objectValue(evidence["claimCommitment"]);
  const anchors = evidence["anchors"];
  if (
    !coverage ||
    !claimCommitment ||
    ![
      "synthetic-observation-v1",
      "memory-claim-v1",
      "canon-claim-v1",
    ].includes(
      String(claimCommitment["schema"]),
    ) ||
    typeof claimCommitment["hash"] !== "string" ||
    !SHA256_RE.test(claimCommitment["hash"] as string) ||
    typeof evidence["supportHash"] !== "string" ||
    !SHA256_RE.test(evidence["supportHash"] as string) ||
    !["complete", "partial"].includes(String(coverage["claim"])) ||
    !["complete", "partial"].includes(String(coverage["sources"])) ||
    !["complete", "partial"].includes(String(evidence["completeness"])) ||
    !Array.isArray(anchors) ||
    anchors.length < 1 ||
    anchors.length > MAX_FINE_GRAINED_ANCHORS ||
    !anchors.every(isAnchor)
  ) {
    return false;
  }
  const identities = new Set(
    anchors.map((anchor) =>
      JSON.stringify([
        anchor.kind,
        anchor.path,
        anchor.location.startByte,
        anchor.location.endByte,
        anchor.kind === "json_config_value" ? anchor.location.keyPath : null,
      ]),
    ),
  );
  if (identities.size !== anchors.length) return false;
  if (
    coverage["claim"] === "complete" &&
    claimCommitment["hash"] !== evidence["supportHash"]
  ) {
    return false;
  }
  const structurallyTyped = evidence as unknown as FineGrainedEvidence;
  // Caller flips from partial to complete cannot pass while the exact stored
  // claim and operation-supported claim commitments differ.
  const complete = derivedCompleteness(structurallyTyped);
  return evidence["completeness"] === (complete ? "complete" : "partial");
}

export function isActionableFineGrainedEvidence(
  value: unknown,
): value is FineGrainedEvidence {
  return isFineGrainedEvidence(value) && value.completeness === "complete";
}

function cloneContext(context: FineGrainedTextContext): FineGrainedTextContext {
  return {
    normalization: "text-lf-trailing-whitespace-v1",
    before: { ...context.before },
    after: { ...context.after },
    prefix: { ...context.prefix },
    suffix: { ...context.suffix },
  };
}

function cloneLocation(location: FineGrainedTextLocation): FineGrainedTextLocation {
  return {
    startLine: location.startLine,
    endLine: location.endLine,
    startColumn: location.startColumn,
    endColumn: location.endColumn,
    startByte: location.startByte,
    endByte: location.endByte,
    byteLength: location.byteLength,
    lineCount: location.lineCount,
    startAtLineStart: location.startAtLineStart,
    endAtLineEnd: location.endAtLineEnd,
  };
}

/** Clone only known format-1 fields so imported `status: verified` assertions
 * or other caller decorations are never persisted as trust metadata. */
export function cloneFineGrainedEvidence(
  value: unknown,
): FineGrainedEvidence | null {
  if (!isFineGrainedEvidence(value)) return null;
  return {
    format: FINE_GRAINED_EVIDENCE_FORMAT,
    claimCommitment: { ...value.claimCommitment },
    supportHash: value.supportHash,
    coverage: { ...value.coverage },
    completeness: value.completeness,
    anchors: value.anchors.map((anchor): FineGrainedAnchor => {
      const common = {
        kind: anchor.kind,
        path: anchor.path,
        rawHash: anchor.rawHash,
        normalizedHash: anchor.normalizedHash,
        normalization: anchor.normalization,
        locatorHash: anchor.locatorHash,
        occurrence: { ...anchor.occurrence },
        contentCompleteness: "complete" as const,
        ...(anchor.sourceCommit ? { sourceCommit: anchor.sourceCommit } : {}),
      };
      if (anchor.kind === "json_config_value") {
        return {
          ...common,
          kind: "json_config_value",
          normalization: "json-canonical-value-v1",
          location: {
            ...cloneLocation(anchor.location),
            keyPath: [...anchor.location.keyPath],
          },
        };
      }
      return {
        ...common,
        kind: anchor.kind,
        normalization: "text-lf-trailing-whitespace-v1",
        location: cloneLocation(anchor.location),
        context: cloneContext(anchor.context),
      };
    }),
  };
}

export function canonicalFineGrainedEvidence(
  value: unknown,
): FineGrainedEvidence | null {
  const cloned = cloneFineGrainedEvidence(value);
  if (!cloned) return null;
  cloned.anchors.sort((left, right) => {
    const a = JSON.stringify([
      left.path,
      left.kind,
      left.location.startByte,
      left.location.endByte,
    ]);
    const b = JSON.stringify([
      right.path,
      right.kind,
      right.location.startByte,
      right.location.endByte,
    ]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return cloned;
}

export function mapFineGrainedEvidencePaths(
  value: unknown,
  mapPath: (path: string) => string | null,
): FineGrainedEvidence | null {
  const cloned = cloneFineGrainedEvidence(value);
  if (!cloned) return null;
  for (const anchor of cloned.anchors) {
    const mapped = mapPath(anchor.path);
    if (!mapped || !isPortableAnchorPath(mapped)) return null;
    anchor.path = mapped;
  }
  return isFineGrainedEvidence(cloned) ? cloned : null;
}

export type FineGrainedAnchorStatus =
  | "raw_match"
  | "cosmetic_match"
  | "drifted"
  | "missing"
  | "ambiguous";

export interface FineGrainedAnchorCheck {
  kind: FineGrainedAnchor["kind"];
  path: string;
  status: FineGrainedAnchorStatus;
}

export interface FineGrainedVerification {
  status: FineGrainedAnchorStatus;
  actionable: boolean;
  reason: string;
  anchors: FineGrainedAnchorCheck[];
}

type FineGrainedTextAnchor = Extract<
  FineGrainedAnchor,
  { kind: "edit_span" | "line_range" }
>;

interface CandidateScan {
  matches: number;
  contextRejected: boolean;
}

function rawCandidateFitsLocation(
  lines: ByteLine[],
  start: number,
  end: number,
  anchor: FineGrainedTextAnchor,
): boolean {
  const startIndex = lineIndexAt(lines, start);
  const endIndex = lineIndexAt(lines, end);
  const startLine = lines[startIndex]!;
  const endLine = lines[endIndex]!;
  if (
    endIndex - startIndex !==
    anchor.location.endLine - anchor.location.startLine
  ) {
    return false;
  }
  if (anchor.location.startAtLineStart && start !== startLine.start) return false;
  if (anchor.location.endAtLineEnd && end !== endLine.contentEnd) return false;
  return true;
}

function candidateContextSideMatches(
  bytes: Buffer,
  lines: ByteLine[],
  startIndex: number,
  endIndex: number,
  direction: "before" | "after",
  expected: FineGrainedContextSide,
): boolean {
  const logicalCount = logicalLineCount(lines, bytes);
  if (expected.boundary) {
    return direction === "before"
      ? startIndex === 0
      : endIndex >= logicalCount - 1;
  }
  let first: number;
  let last: number;
  if (direction === "before") {
    if (startIndex < expected.lineCount) return false;
    first = startIndex - expected.lineCount;
    last = startIndex - 1;
  } else {
    first = endIndex + 1;
    last = endIndex + expected.lineCount;
    if (last >= logicalCount) return false;
  }
  const contextBytes = bytes.subarray(lines[first]!.start, lines[last]!.contentEnd);
  if (contextBytes.byteLength > MAX_ANCHOR_CONTEXT_BYTES) return false;
  const rawHash = sha256(contextBytes);
  const normalizedHash = normalizedTextHash(contextBytes);
  return (
    rawHash === expected.rawHash ||
    (normalizedHash !== null && normalizedHash === expected.normalizedHash)
  );
}

function candidateInlineContextMatches(
  bytes: Buffer,
  lines: ByteLine[],
  start: number,
  end: number,
  direction: "prefix" | "suffix",
  expected: FineGrainedInlineContextSide,
): boolean {
  const lineIndex = lineIndexAt(lines, direction === "prefix" ? start : end);
  const line = lines[lineIndex]!;
  const contextBytes =
    direction === "prefix"
      ? bytes.subarray(Math.max(line.start, start - expected.byteLength), start)
      : bytes.subarray(end, Math.min(line.contentEnd, end + expected.byteLength));
  if (contextBytes.byteLength !== expected.byteLength) return false;
  const rawHash = sha256(contextBytes);
  const normalizedHash = normalizedTextHash(contextBytes);
  return (
    rawHash === expected.rawHash ||
    (normalizedHash !== null && normalizedHash === expected.normalizedHash)
  );
}

function candidateContextMatches(
  bytes: Buffer,
  lines: ByteLine[],
  start: number,
  end: number,
  anchor: FineGrainedTextAnchor,
): boolean {
  // The capture location itself is already deterministic. Context is required
  // only for relocation, preventing an identical snippet in another block from
  // silently inheriting the claim.
  if (start === anchor.location.startByte) return true;
  const startIndex = lineIndexAt(lines, start);
  const endIndex = lineIndexAt(lines, end);
  return (
    candidateContextSideMatches(
      bytes,
      lines,
      startIndex,
      endIndex,
      "before",
      anchor.context.before,
    ) &&
    candidateContextSideMatches(
      bytes,
      lines,
      startIndex,
      endIndex,
      "after",
      anchor.context.after,
    ) &&
    candidateInlineContextMatches(
      bytes,
      lines,
      start,
      end,
      "prefix",
      anchor.context.prefix,
    ) &&
    candidateInlineContextMatches(
      bytes,
      lines,
      start,
      end,
      "suffix",
      anchor.context.suffix,
    )
  );
}

function rawMatches(
  bytes: Buffer,
  anchor: FineGrainedTextAnchor,
): CandidateScan | null {
  const length = anchor.location.byteLength;
  if (length > bytes.byteLength) return { matches: 0, contextRejected: false };
  const lines = byteLines(bytes);
  let hash = 0;
  for (let i = 0; i < length; i++) {
    hash = (Math.imul(hash, LOCATOR_BASE) + bytes[i]!) >>> 0;
  }
  let power = 1;
  for (let i = 1; i < length; i++) power = Math.imul(power, LOCATOR_BASE) >>> 0;
  const target = parseInt(anchor.locatorHash, 16) >>> 0;
  let locatorCollisions = 0;
  let cryptographicBytes = 0;
  let matches = 0;
  let contextRejected = false;
  for (let start = 0; start <= bytes.byteLength - length; start++) {
    if (hash === target) {
      locatorCollisions++;
      if (locatorCollisions > MAX_LOCATOR_COLLISIONS) return null;
      const end = start + length;
      if (rawCandidateFitsLocation(lines, start, end, anchor)) {
        cryptographicBytes += length;
        if (cryptographicBytes > MAX_CANDIDATE_HASH_BYTES) return null;
        if (sha256(bytes.subarray(start, end)) === anchor.rawHash) {
          if (candidateContextMatches(bytes, lines, start, end, anchor)) {
            matches++;
            if (matches > 1) return { matches, contextRejected };
          } else {
            contextRejected = true;
          }
        }
      }
    }
    if (start === bytes.byteLength - length) break;
    const without = (hash - Math.imul(bytes[start]!, power)) >>> 0;
    hash =
      (Math.imul(without, LOCATOR_BASE) + bytes[start + length]!) >>> 0;
  }
  return { matches, contextRejected };
}

function normalizedTextMatches(
  bytes: Buffer,
  anchor: FineGrainedTextAnchor,
): CandidateScan | null {
  const lines = byteLines(bytes);
  if (lines.length > MAX_ANCHOR_NORMALIZED_CANDIDATES) return null;
  const delta = anchor.location.endLine - anchor.location.startLine;
  let hashedBytes = 0;
  let matches = 0;
  let contextRejected = false;
  for (let index = 0; index + delta < lines.length; index++) {
    const startLine = lines[index]!;
    const endLine = lines[index + delta]!;
    const start = anchor.location.startAtLineStart
      ? startLine.start
      : startLine.start + anchor.location.startColumn;
    const end = anchor.location.endAtLineEnd
      ? endLine.contentEnd
      : endLine.start + anchor.location.endColumn;
    if (
      start < startLine.start ||
      start > startLine.contentEnd ||
      end < endLine.start ||
      end > endLine.contentEnd ||
      end <= start ||
      end - start > MAX_ANCHOR_CONTENT_BYTES
    ) {
      continue;
    }
    hashedBytes += end - start;
    if (hashedBytes > MAX_CANDIDATE_HASH_BYTES) return null;
    const candidate = normalizedTextHash(bytes.subarray(start, end));
    if (candidate === anchor.normalizedHash) {
      if (candidateContextMatches(bytes, lines, start, end, anchor)) {
        matches++;
        if (matches > 1) return { matches, contextRejected };
      } else {
        contextRejected = true;
      }
    }
  }
  return { matches, contextRejected };
}

function verifyTextAnchor(
  bytes: Buffer,
  anchor: FineGrainedTextAnchor,
): FineGrainedAnchorStatus {
  const raw = rawMatches(bytes, anchor);
  if (raw === null || raw.matches > 1) return "ambiguous";
  if (raw.matches === 1) return "raw_match";
  const normalized = normalizedTextMatches(bytes, anchor);
  if (normalized === null || normalized.matches > 1) return "ambiguous";
  if (normalized.matches === 1) return "cosmetic_match";
  return raw.contextRejected || normalized.contextRejected
    ? "ambiguous"
    : "drifted";
}

function verifyConfigAnchor(
  bytes: Buffer,
  anchor: Extract<FineGrainedAnchor, { kind: "json_config_value" }>,
): FineGrainedAnchorStatus {
  const text = decodeUtf8(bytes);
  if (text === null) return "ambiguous";
  const key = anchor.location.keyPath[0]!;
  const spans = jsonSpans(text, key);
  if (!spans) return "ambiguous";
  if (spans.length === 0) return "drifted";
  if (spans.length !== 1) return "ambiguous";
  const span = spans[0]!;
  const raw = Buffer.from(text.slice(span.pairStart, span.pairEnd), "utf8");
  if (sha256(raw) === anchor.rawHash) return "raw_match";
  const normalized = canonicalConfigValue(key, span.value);
  return normalized && sha256(normalized) === anchor.normalizedHash
    ? "cosmetic_match"
    : "drifted";
}

function aggregateStatus(
  checks: readonly FineGrainedAnchorCheck[],
): FineGrainedAnchorStatus {
  if (checks.some((check) => check.status === "missing")) return "missing";
  if (checks.some((check) => check.status === "ambiguous")) return "ambiguous";
  if (checks.some((check) => check.status === "drifted")) return "drifted";
  if (checks.some((check) => check.status === "cosmetic_match")) {
    return "cosmetic_match";
  }
  return "raw_match";
}

/** Re-hash every anchor against a real checkout. Invalid metadata, unsafe paths,
 * oversized inputs, parser failure, and non-unique relocation all fail closed
 * as `ambiguous`; no status is read from persisted data. */
export function verifyFineGrainedEvidence(
  value: unknown,
  root: string,
  claim?: FineGrainedClaimCommitment,
): FineGrainedVerification {
  if (!isFineGrainedEvidence(value)) {
    return {
      status: "ambiguous",
      actionable: false,
      reason: "fine-grained anchor metadata is malformed",
      anchors: [],
    };
  }
  const checks: FineGrainedAnchorCheck[] = [];
  for (const anchor of value.anchors) {
    const read = readBoundedFileUnderRoot(
      root,
      anchor.path,
      MAX_ANCHOR_FILE_BYTES,
    );
    let status: FineGrainedAnchorStatus;
    if (!read.ok) {
      status = read.reason === "missing" ? "missing" : "ambiguous";
    } else if (anchor.kind === "json_config_value") {
      status = verifyConfigAnchor(read.bytes, anchor);
    } else {
      status = verifyTextAnchor(read.bytes, anchor);
    }
    checks.push({ kind: anchor.kind, path: anchor.path, status });
  }
  const status = aggregateStatus(checks);
  const claimMatches = fineGrainedEvidenceMatchesClaim(value, claim);
  const actionable =
    isActionableFineGrainedEvidence(value) && claimMatches;
  return {
    status,
    actionable,
    reason:
      !claimMatches
        ? "fine-grained claim commitment is missing or does not match stored content"
        : status === "raw_match"
        ? "all complete fine-grained anchors match their exact capture hashes"
        : status === "cosmetic_match"
          ? "all complete fine-grained anchors match after their declared normalization"
          : status === "missing"
            ? "a fine-grained anchor source is missing"
            : status === "drifted"
              ? "a fine-grained anchor no longer matches its capture commitment"
              : "fine-grained anchors cannot be resolved unambiguously",
    anchors: checks,
  };
}
