//
// Supervised standby. A launchd/systemd-supervised daemon that finds another
// memwarden already serving its port must not exit 0: the supervisor reads
// that as "job finished" and never restarts the brain again until the next
// login, so the unsupervised winner runs with no crash recovery. Instead the
// supervised instance waits here, holding nothing (no store, no log
// rotation), and boots the moment the port is released.

/** Who holds the REST port right now. */
export type PortHolder =
  /** a memwarden daemon answered /livez */
  | "memwarden"
  /** something accepted the connection but did not answer in time */
  | "busy"
  /** nothing is listening */
  | "free"
  /** something that is not memwarden answered */
  | "foreign";

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

function isRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  return cause?.code === "ECONNREFUSED";
}

export async function probePort(
  port: number,
  opts: { timeoutMs?: number; fetchFn?: FetchLike } = {},
): Promise<PortHolder> {
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/memwarden/livez`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!res.ok) return "foreign";
    const body = (await res.json().catch(() => null)) as { service?: unknown } | null;
    return body?.service === "memwarden" ? "memwarden" : "foreign";
  } catch (err) {
    if (isRefused(err)) return "free";
    // A timeout is what a memwarden blocked in a long synchronous task looks
    // like, and no other socket error proves the port is free either.
    // Booting would only lose the bind, so keep waiting.
    return "busy";
  }
}

/**
 * Wait until no memwarden holds `port`. Returns "free" (boot normally) or
 * "foreign" (a different program holds it; booting will report the
 * conflict). Never returns while a memwarden is serving.
 */
export async function awaitPortHandoff(
  port: number,
  opts: {
    intervalMs?: number;
    probe?: (port: number) => Promise<PortHolder>;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  } = {},
): Promise<"free" | "foreign"> {
  const probe = opts.probe ?? ((p: number) => probePort(p));
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.log(line));
  let announced = false;
  for (;;) {
    const holder = await probe(port);
    if (holder === "free" || holder === "foreign") {
      if (announced) log(`[memwarden] standby: port ${port} released; taking over.`);
      return holder;
    }
    if (!announced) {
      log(
        `[memwarden] standby: another memwarden holds port ${port}; this supervised ` +
          `instance takes over when it exits.`,
      );
      announced = true;
    }
    await sleep(opts.intervalMs ?? 5000);
  }
}

/** EX_TEMPFAIL: lost the bind race to another memwarden; the supervisor
 * relaunches us and the relaunch waits in standby. */
export const EXIT_RETRY_STANDBY = 75;
