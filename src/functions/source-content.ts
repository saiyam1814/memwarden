//
// Shared bounded source hashing primitives. Raw SHA-256 is always the trust
// commitment; normalization is explicit and additive. Safe relative reads
// resolve symlinks before reading and refuse any target outside the supplied
// checkout root.
//

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

export const MAX_SOURCE_HASH_BYTES = 2_000_000;
export const SHA256_RE = /^[a-f0-9]{64}$/;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The format-1 cosmetic normalization shared by live recall and Canon. */
export function normalizeSourceText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "\n");
}

export function normalizedTextHash(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  const text = decodeUtf8(bytes);
  return text === null ? null : sha256(normalizeSourceText(text));
}

export type BoundedReadFailure =
  | "missing"
  | "unsafe"
  | "not_file"
  | "too_large"
  | "unreadable";

export type BoundedReadResult =
  | { ok: true; path: string; bytes: Buffer }
  | { ok: false; reason: BoundedReadFailure };

export function readBoundedFile(
  absolutePath: string,
  maxBytes = MAX_SOURCE_HASH_BYTES,
): BoundedReadResult {
  try {
    const st = statSync(absolutePath);
    if (!st.isFile()) return { ok: false, reason: "not_file" };
    if (st.size > maxBytes) return { ok: false, reason: "too_large" };
    const bytes = readFileSync(absolutePath);
    if (bytes.byteLength > maxBytes) return { ok: false, reason: "too_large" };
    return { ok: true, path: absolutePath, bytes };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
    };
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** Read a relative source path without permitting lexical traversal or a
 * symlinked parent/file to escape the checkout. The resolved target path, not
 * the attacker-controlled spelling, is what is read. */
export function readBoundedFileUnderRoot(
  root: string,
  file: string,
  maxBytes = MAX_SOURCE_HASH_BYTES,
): BoundedReadResult {
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    typeof file !== "string" ||
    !file ||
    isAbsolute(file) ||
    file.includes("\0")
  ) {
    return { ok: false, reason: "unsafe" };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    if (!statSync(realRoot).isDirectory()) return { ok: false, reason: "unsafe" };
  } catch {
    return { ok: false, reason: "unsafe" };
  }
  const lexical = resolve(realRoot, file);
  if (!isInside(realRoot, lexical)) return { ok: false, reason: "unsafe" };

  let target: string;
  try {
    target = realpathSync(lexical);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
    };
  }
  if (!isInside(realRoot, target)) return { ok: false, reason: "unsafe" };
  return readBoundedFile(target, maxBytes);
}

export function normalizedHashFile(absolutePath: string): string | null {
  const read = readBoundedFile(absolutePath);
  return read.ok ? normalizedTextHash(read.bytes) : null;
}
