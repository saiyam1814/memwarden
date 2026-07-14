//
// Test isolation from the DEVELOPER'S REAL BRAIN.
//
// getSecret() (functions/config.ts) resolves the shared secret as env var
// first, then the persisted `<dataDir>/secret` file — where dataDir defaults
// to ~/.memwarden. That fallback is correct in production: it lets a CLI
// command run from a plain shell authenticate to a secured daemon.
//
// But the suite boots the full stack (registerApiTriggers, api-auth included)
// and calls /memwarden/* WITHOUT an auth header, relying on the middleware's
// "absent secret = open" contract. On a machine that has run `memwarden up`,
// ~/.memwarden/secret exists, so the middleware starts REQUIRING auth and
// every unauthenticated test call 401s — a green suite on a clean machine and
// a red one on a maintainer's, from identical code.
//
// So: point the data dir at a throwaway temp dir and clear the secret env
// before any test runs. `pool: "forks"` gives each test FILE its own process,
// so each gets its own dir and getSecret()'s one-shot file read caches "no
// secret". Tests never read $HOME, and the suite depends on the code alone.
//
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MEMWARDEN_DATA_DIR = mkdtempSync(join(tmpdir(), "memwarden-test-"));
delete process.env.MEMWARDEN_SECRET;
