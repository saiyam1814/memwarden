//
// memwarden boot entrypoint. Mirrors the the original implementation worker boot but
// against the in-process kernel instead of an external engine:
// - build the kernel via registerWorker (the the external engine SDK stand-in),
// - register app functions (./functions/*) if present,
// - start the node:http REST server on restPort,
// - keep the periodic sweeps as plain setInterval(...).unref() timers
// that fire `trigger mem::*` (no scheduler in the SDK surface),
// - graceful shutdown on SIGINT/SIGTERM.
//
// Phase 0: the ./functions/* modules may not all exist yet. Function
// registration is therefore best-effort: a missing module is logged and
// skipped so the kernel still boots and serves whatever is wired.

import { registerWorker, startHttpServer } from "./kernel/index.js";
import type { Kernel } from "./kernel/index.js";
import { StoreLibsql } from "./state/store-libsql.js";
import { StateKV } from "./state/kv.js";
import {
  registerCoreFunctions,
  setEmbeddingProvider,
  setVectorIndex,
  makeVectorIndex,
} from "./functions/index.js";
import {
  isQuantizedVectorEnabled,
  isProxyEnabled,
  getUpstreamUrl,
  getUpstreamKey,
  getProxyPort,
  getSecret,
} from "./functions/config.js";
import { createEmbeddingProvider } from "./embedding/index.js";
import { registerApiTriggers } from "./triggers/api.js";
import { startProxyServer } from "./proxy/server.js";

const REST_PORT = parseInt(process.env.MEMWARDEN_REST_PORT ?? "3111", 10);
const STORE_URL =
  process.env.MEMWARDEN_STORE_URL ??
  (process.env.MEMWARDEN_DATA_DIR
    ? `file:${process.env.MEMWARDEN_DATA_DIR}/memwarden.db`
    : "file:./data/memwarden.db");

// Top-level safety net. Under sustained write load a single `state::*`
// or fire-and-forget trigger rejection should never terminate the
// long-lived memory service. The kernel surfaces rejections to the
// relevant call site via .catch(); everything else is logged and
// continued. Throttle to avoid spamming on bursts (mirrors the original implementation
// index.ts which reads reason.code / function_id / message).
let lastUnhandledLogAt = 0;
process.on("unhandledRejection", (reason) => {
  const now = Date.now();
  if (now - lastUnhandledLogAt < 60_000) return;
  lastUnhandledLogAt = now;
  const r = reason as { code?: string; function_id?: string; message?: string };
  console.warn(
    `[memwarden] unhandledRejection (suppressed):`,
    r?.code
      ? `${r.code} ${r.function_id ?? ""} ${r.message ?? ""}`.trim()
      : reason,
  );
});

/**
 * Optionally load a function-registration module by path and call its
 * exported registrar. Missing modules are skipped (Phase 0 tolerance).
 */
async function tryRegister(
  modulePath: string,
  exportName: string,
  ...args: unknown[]
): Promise<boolean> {
  try {
    const mod = (await import(modulePath)) as Record<string, unknown>;
    const fn = mod[exportName];
    if (typeof fn === "function") {
      (fn as (...a: unknown[]) => void)(...args);
      return true;
    }
    return false;
  } catch (err) {
    const code = (err as { code?: string }).code;
    // ERR_MODULE_NOT_FOUND is expected while functions are still being
    // ported; anything else is a real registration failure worth a log.
    if (code !== "ERR_MODULE_NOT_FOUND") {
      console.warn(
        `[memwarden] failed to register ${exportName} from ${modulePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return false;
  }
}

/**
 * Register the application functions against the kernel.
 *
 * The Phase-0 core (mem::observe / mem::context / mem::search and their
 * HTTP routes) is wired statically: the modules exist and share a single
 * StateKV constructed over the kernel. Functions still being ported
 * (smart-search, remember, enrich, events, health) remain best-effort
 * dynamic imports so the kernel still boots while they land.
 */
async function registerFunctions(sdk: Kernel): Promise<number> {
  // Core path: one StateKV over the kernel, shared by all three functions.
  const kv = new StateKV(sdk);
  registerCoreFunctions(sdk, kv);
  registerApiTriggers(sdk);

  let registered = 3; // observe + context + search

  // Functions still being ported; absent modules are no-ops.
  const tasks: Array<Promise<boolean>> = [
    tryRegister("./functions/smart-search.js", "registerSmartSearchFunction", sdk),
    tryRegister("./functions/remember.js", "registerRememberFunction", sdk),
    tryRegister("./functions/enrich.js", "registerEnrichFunction", sdk),
    tryRegister("./triggers/events.js", "registerEventTriggers", sdk),
    tryRegister("./health/monitor.js", "registerHealthMonitor", sdk),
  ];
  const results = await Promise.all(tasks);
  for (const ok of results) if (ok) registered++;
  return registered;
}

/**
 * Install the periodic maintenance sweeps. The SDK surface has no cron
 * primitive: these are plain unref'd interval timers that fire a
 * `trigger mem::*`. A trigger to an unregistered function rejects
 * harmlessly (caught here), so this is safe to install before the
 * corresponding functions are ported.
 */
function installSweeps(sdk: Kernel): Array<NodeJS.Timeout> {
  const timers: Array<NodeJS.Timeout> = [];
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  const fire = (functionId: string, payload: unknown) => {
    sdk
      .trigger({ function_id: functionId, payload })
      .catch(() => undefined);
  };

  const schedule = (
    enabled: boolean,
    intervalMs: number,
    functionId: string,
    payload: unknown,
  ) => {
    if (!enabled) return;
    // Small jitter spreads sweep load so they don't all fire on the
    // same tick after a restart.
    const jitter = Math.floor(Math.random() * Math.min(intervalMs, 60_000));
    const timer = setInterval(() => fire(functionId, payload), intervalMs);
    timer.unref();
    timers.push(timer);
    const kickoff = setTimeout(() => fire(functionId, payload), jitter);
    kickoff.unref();
  };

  const autoForgetInterval = parseInt(
    process.env.AUTO_FORGET_INTERVAL_MS ?? "3600000",
    10,
  );
  const consolidationInterval = parseInt(
    process.env.CONSOLIDATION_INTERVAL_MS ?? "7200000",
    10,
  );

  schedule(
    process.env.AUTO_FORGET_ENABLED !== "false",
    autoForgetInterval,
    "mem::auto-forget",
    { dryRun: false },
  );
  schedule(
    process.env.LESSON_DECAY_ENABLED !== "false",
    DAY,
    "mem::lesson-decay-sweep",
    {},
  );
  schedule(
    process.env.INSIGHT_DECAY_ENABLED !== "false",
    DAY,
    "mem::insight-decay-sweep",
    {},
  );
  schedule(true, HOUR, "mem::diagnostic::recent-searches-sweep", {});
  schedule(
    process.env.CONSOLIDATION_ENABLED === "true",
    consolidationInterval,
    "mem::consolidate-pipeline",
    {},
  );

  return timers;
}

async function main(): Promise<void> {
  const store = new StoreLibsql({ url: STORE_URL });
  const sdk = registerWorker(
    "in-process",
    {
      workerName: "memwarden",
      invocationTimeoutMs: 180000,
    },
    { store },
  );

  const registered = await registerFunctions(sdk);
  console.log(
    `[memwarden] kernel ready — ${registered} function module(s) registered, store=${STORE_URL}`,
  );

  // Semantic memory: wire the embedding provider and the (TurboQuant-
  // compressed by default) vector index. With no provider, memwarden runs
  // BM25-only — identical to the prior behavior. The model loads lazily on
  // first observe/search; warm it in the background so the first request is
  // fast without blocking boot.
  const embProvider = createEmbeddingProvider();
  if (embProvider) {
    setEmbeddingProvider(embProvider);
    setVectorIndex(makeVectorIndex(embProvider.dimensions));
    const quantized = isQuantizedVectorEnabled();
    console.log(
      `[memwarden] semantic memory: ${embProvider.name} (${embProvider.dimensions}d), ` +
        `storage=${quantized ? "TurboQuant-compressed" : "full-precision"}`,
    );
    const warmable = embProvider as { warmup?: () => Promise<void> };
    if (typeof warmable.warmup === "function") {
      warmable.warmup().catch((err: unknown) => {
        console.warn(
          `[memwarden] embedding model warmup failed — vector stream stays off until it loads:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  } else {
    console.log(`[memwarden] semantic memory: disabled (BM25-only)`);
  }

  const http = startHttpServer(sdk, { port: REST_PORT });
  // Race-safe self-heal: if another memwarden already holds the port, this
  // spawn is redundant — exit cleanly (0) rather than crash, so concurrent
  // ensureDaemon() callers never surface an error.
  http.server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(
        `[memwarden] port ${REST_PORT} already in use — another instance is running; exiting.`,
      );
      process.exit(0);
    }
    console.error(`[memwarden] HTTP server error:`, err);
    process.exit(1);
  });
  console.log(
    `[memwarden] REST API: http://127.0.0.1:${REST_PORT}/memwarden/*`,
  );

  // The memory proxy — the universal cross-tool layer. Off until an upstream
  // is configured (it has nothing to forward to otherwise). When on, point
  // any OpenAI-compatible tool's base URL at it and every model call, local
  // or paid, flows through memwarden's recall + capture.
  let proxy: { close(): Promise<void> } | undefined;
  const upstreamUrl = getUpstreamUrl();
  if (isProxyEnabled() && upstreamUrl) {
    const proxyPort = getProxyPort();
    const cwd = process.cwd();
    proxy = startProxyServer({
      port: proxyPort,
      upstreamUrl,
      daemonUrl: `http://127.0.0.1:${REST_PORT}`,
      project: cwd,
      cwd,
      ...(getUpstreamKey() ? { upstreamKey: getUpstreamKey() as string } : {}),
      ...(getSecret() ? { secret: getSecret() as string } : {}),
    });
    console.log(
      `[memwarden] memory proxy: http://127.0.0.1:${proxyPort}/v1 -> ${upstreamUrl} ` +
        `(point any OpenAI-compatible tool here for automatic memory)`,
    );
  }

  const timers = installSweeps(sdk);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[memwarden] Shutting down...`);
    for (const t of timers) clearInterval(t);
    await http.close().catch(() => undefined);
    if (proxy) await proxy.close().catch(() => undefined);
    await sdk.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(`[memwarden] Fatal:`, err);
  process.exit(1);
});
