// Vitest configuration. The defaults already work, but this pins four things
// the suite relies on:
//
//   - include: only the `test/` directory (no stray src spec discovery).
//   - pool "forks": run each test FILE in its own child process. Several
//     modules expose process-level singletons (the kernel via registerWorker,
//     the BM25 search index, the embedding/vector index). Per-file process
//     isolation guarantees one file's leftover singleton state can never bleed
//     into another's, which matters for the parity / e2e files that boot a
//     real kernel + libSQL store + HTTP server.
//   - testTimeout: a margin above the default for the e2e file, which opens a
//     node:http server on an ephemeral port and round-trips fetch() calls.
//   - setupFiles: isolate the suite from the developer's real ~/.memwarden —
//     see test/setup.ts. Without it, a machine that has run `memwarden up`
//     fails 21 tests on unmodified code.
//
// No reporters/coverage are configured: the suite is dependency-free beyond
// what package.json already declares (vitest, tsx, typescript).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
