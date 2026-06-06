//
// Minimal structured logger. the original logger.ts is a larger
// leveled/redacting implementation; the Phase-0 port only needs the
// info/warn/error/debug surface the ported functions call, writing JSON
// lines to stderr so log output never corrupts a stdout protocol stream.
// Level is gated by MEMWARDEN_LOG_LEVEL (default "info").

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function threshold(): number {
  const raw = (process.env.MEMWARDEN_LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[(raw as Level)] ?? LEVELS.info;
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ?? {}),
  };
  try {
    process.stderr.write(`${JSON.stringify(line)}\n`);
  } catch {
    // Logging must never throw into the call path.
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) =>
    emit("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) =>
    emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    emit("error", message, meta),
};
