# Contributing to memwarden

Thanks for looking under the hood. This project has a few hard rules that PRs are judged
against — knowing them up front saves everyone a round trip.

## Ground rules

1. **Honest claims only.** Every performance or behavior claim in the README, site, or CLI
   output must be measured, reproducible, and worded for exactly what it is. "Tamper-evident,
   not tamper-proof" is the house style. If your feature can fail, the failure mode gets
   documented, not hidden.
2. **Zero native dependencies in the core.** Runtime deps are `@libsql/client` + `zod`
   (+ optional `@huggingface/transformers` and the optional prebuilt `@memwarden/turbovec`).
   Anything else needs a very good reason.
3. **Tests are not optional.** New behavior ships with tests; bug fixes ship with a test that
   reproduces the bug first. Green unit tests have lied here before — for anything touching
   the daemon, REST, or MCP path, smoke-test the real thing (`npm run demo:firewall` boots a
   real daemon).
4. **Strict TypeScript.** `NodeNext`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
   `npx tsc --noEmit` must be clean.

## Dev setup

```bash
git clone https://github.com/saiyam1814/memwarden && cd memwarden
npm install
npm test              # vitest, the full suite
npx tsc --noEmit      # typecheck
npm run eval          # firewall eval — CI gates at 100% on every metric
npm run demo:trust    # the product thesis, no daemon needed
```

## Before you open a PR

- `npm test`, `npx tsc --noEmit`, and `npm run eval` all pass locally.
- If you touched recall, verification, or the oplog: run `npm run demo:firewall` and read the
  output — it exercises the real capture → drift → refusal → erase path.
- If you changed user-facing wording, check it against the ground rules above.

## Security

Do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
