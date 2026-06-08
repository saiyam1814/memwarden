//
// Per-key serialization. Calls that share a key run one at a time, chained on
// a promise so each waits for the previous to settle (whether it resolved or
// threw). Used to serialize the observe write path per session so counters and
// rollbacks stay race-free. Correct only for a single in-process instance; a
// multi-process memwarden would need a real distributed lock.

const chains = new Map<string, Promise<unknown>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  // Run after the prior call settles either way (pass fn for both branches).
  const run = prior.then(fn, fn);
  // A branch that never rejects, used both to keep the chain going past a
  // failure and to release the key once nothing is queued behind it.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}
