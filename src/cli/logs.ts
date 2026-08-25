//
// Bounded reader for the one configured daemon log. There is deliberately no
// caller-supplied path: `memwarden logs` can never become an arbitrary-file
// reader. Reads are byte-capped, line-capped, no-follow, secret-redacted, and
// control-character sanitized before anything reaches a terminal or JSON.
//

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { daemonLogPath, defaultDataDir } from "../daemon/ensure.js";
import {
  sanitizeUntrustedLine,
  sanitizeUntrustedText,
} from "../functions/injection-format.js";
import { stripPrivateData } from "../functions/privacy.js";

export const DEFAULT_LOG_LINES = 100;
export const MAX_LOG_LINES = 1_000;
export const MAX_LOG_READ_BYTES = 2 * 1024 * 1024;
export const MAX_LOG_LINE_CHARS = 8_192;

export interface DaemonLogResult {
  format: "memwarden.logs.v1";
  path: string;
  tail: boolean;
  requestedLines: number;
  returnedLines: number;
  exists: boolean;
  truncated: boolean;
  lines: string[];
}

function validateLineCount(value: number | undefined): number {
  const lines = value ?? DEFAULT_LOG_LINES;
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) {
    throw new Error(`--lines must be an integer between 1 and ${MAX_LOG_LINES}`);
  }
  return lines;
}

export function sanitizeDaemonLogLine(
  line: string,
  secret?: string,
): string {
  // Normalize terminal/control obfuscation before secret matching; otherwise
  // an ANSI sequence inserted into a token could disappear after redaction and
  // reconstruct the credential in our output.
  let sanitized = sanitizeUntrustedLine(line);
  if (secret) sanitized = sanitized.split(secret).join("[REDACTED_SECRET]");
  sanitized = stripPrivateData(sanitized);
  return sanitized.length <= MAX_LOG_LINE_CHARS
    ? sanitized
    : `${sanitized.slice(0, MAX_LOG_LINE_CHARS - 1)}…`;
}

/**
 * Read either the first N lines (default) or the last N (`tail`) from the
 * configured `<dataDir>/daemon.log`. A symlink is rejected rather than
 * followed, even when it points to another regular file.
 */
export function readDaemonLogs(options: {
  dataDir?: string;
  tail?: boolean;
  lines?: number;
  secret?: string;
} = {}): DaemonLogResult {
  const dataDir = options.dataDir ?? defaultDataDir();
  const path = daemonLogPath(dataDir);
  const tail = options.tail === true;
  const requestedLines = validateLineCount(options.lines);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        format: "memwarden.logs.v1",
        path,
        tail,
        requestedLines,
        returnedLines: 0,
        exists: false,
        truncated: false,
        lines: [],
      };
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("configured daemon log is not a regular non-symlink file");
  }

  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const current = fstatSync(fd);
    if (!current.isFile()) {
      throw new Error("configured daemon log is not a regular file");
    }
    const bytes = Math.min(current.size, MAX_LOG_READ_BYTES);
    const start = tail ? Math.max(0, current.size - bytes) : 0;
    const buffer = Buffer.alloc(bytes);
    let read = 0;
    while (read < bytes) {
      const count = readSync(fd, buffer, read, bytes - read, start + read);
      if (count === 0) break;
      read += count;
    }
    let text = buffer.subarray(0, read).toString("utf8");
    let byteTruncated = current.size > read;
    if (tail && start > 0) {
      // The first bytes are probably the tail of a partial line. Drop through
      // the first LF so no fabricated fragment is reported as a complete log.
      const firstLf = text.indexOf("\n");
      text = firstLf === -1 ? "" : text.slice(firstLf + 1);
      byteTruncated = true;
    } else if (!tail && current.size > read) {
      const lastLf = text.lastIndexOf("\n");
      text = lastLf === -1 ? "" : text.slice(0, lastLf + 1);
    }
    // Normalize/redact the bounded block before splitting so a multi-line
    // <private>...</private> span cannot evade per-line sanitation.
    text = sanitizeUntrustedText(text);
    if (options.secret) {
      text = text.split(options.secret).join("[REDACTED_SECRET]");
    }
    text = stripPrivateData(text);
    const allLines = text.split("\n");
    if (allLines.at(-1) === "") allLines.pop();
    const selected = tail
      ? allLines.slice(Math.max(0, allLines.length - requestedLines))
      : allLines.slice(0, requestedLines);
    const lines = selected.map((line) =>
      sanitizeDaemonLogLine(line, options.secret),
    );
    return {
      format: "memwarden.logs.v1",
      path,
      tail,
      requestedLines,
      returnedLines: lines.length,
      exists: true,
      truncated: byteTruncated || allLines.length > lines.length,
      lines,
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
