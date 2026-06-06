//
// In-process per-key promise-chain mutex. Ported verbatim from
// the original src/state/keyed-mutex.ts. Serializes the observe write
// path (key "obs:"+sessionId) so observationCount increments and image
// rollback stay race-free. This is correct ONLY because the kernel is a
// single in-process instance; a multi-process successor would need a real
// distributed lock.

const locks = new Map<string, Promise<void>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.then(
    () => {},
    () => {},
  );
  locks.set(key, cleanup);
  void cleanup.then(() => {
    if (locks.get(key) === cleanup) locks.delete(key);
  });
  return next;
}
