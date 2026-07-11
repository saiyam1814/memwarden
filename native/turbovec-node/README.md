# @memwarden/turbovec

Node bindings (napi-rs) for the [turbovec](https://github.com/RyanCodrai/turbovec)
Rust crate — memwarden's **optional** native vector backend.

turbovec implements TurboQuant vector quantization (2-4 bits per coordinate,
data-oblivious, no codebook training) with SIMD search kernels (NEON on ARM,
AVX-512/AVX2 on x86). This package wraps its `IdMapIndex` — stable external
`u64` ids, `O(1)` remove, allowlist-masked search, validated `.tvim`
persistence (format v3) — as a Node addon.

## Relationship to memwarden

memwarden's core ships with **zero native dependencies** and never lists this
package as a dependency. At boot, when `MEMWARDEN_VECTOR_BACKEND=turbovec` is
set, memwarden dynamic-imports `@memwarden/turbovec` (first the bare
specifier, then `<dataDir>/runtime/node_modules`). If the import fails, it
logs the reason and serves search from the portable TypeScript index instead
— `memwarden status` and `GET /memwarden/stats` always report which engine is
actually active (`turbovec/native-4bit` vs `typescript/turboquant-4bit`).

The string-obsId to u64 mapping, the persistence envelope and all fallback
logic live in memwarden (`src/functions/turbovec-backend.ts`); this package
is a thin, panic-guarded FFI shim.

## API

```js
const { TurbovecIndex } = require("@memwarden/turbovec");

const idx = new TurbovecIndex(384, 4);        // dims (multiple of 8), bitWidth 2|3|4
idx.addWithIds(f32Buffer, new BigUint64Array([1n, 2n, 3n]));
idx.remove(2n);                                // O(1), returns bool
const { ids, scores } = idx.search(query, 10); // ids: BigUint64Array, best first
idx.search(query, 10, new BigUint64Array([1n])); // allowlist-masked
idx.save("index.tvim");
const loaded = TurbovecIndex.load("index.tvim");
idx.len; idx.dims; idx.bitWidth;
```

The two panic paths documented on the crate's `search_with_allowlist` (empty
allowlist, allowlist id not in the index) are guarded at the FFI boundary:
unknown ids are filtered out and an effectively empty allowlist returns an
empty result — JS callers cannot crash the process through the mask.

The allowlist is wired into production search: when `mem::search` carries a
project/cwd filter, it builds the in-scope obsId set and calls
`TurbovecBackend.searchAllowed`, which translates it to this native u64 mask,
so the scope restriction runs inside the SIMD scan instead of post-filtering
a global top-k (see `benchmark/backends.ts`, filtered-search scenario and
GATE 4).

## Building from source

Requires a Rust toolchain (1.70+) and Node 20+.

```sh
cd native/turbovec-node
npm install          # installs @napi-rs/cli (devDependency of THIS package only)
npm run build        # cargo build --release + generates index.js / index.d.ts
```

This produces `memwarden-turbovec.<platform>.node` (e.g.
`memwarden-turbovec.darwin-arm64.node`). The binary is gitignored — it is
always rebuilt from source or shipped as a CI prebuild.

BLAS linkage comes from the turbovec crate's build: Accelerate on macOS,
OpenBLAS on Linux (`libopenblas-dev` / `openblas-devel`), and a pure-Rust
`matrixmultiply` fallback elsewhere.

## Prebuild CI matrix (plan)

| Target | Status |
| --- | --- |
| `aarch64-apple-darwin` (darwin-arm64) | build + test + publish prebuild |
| `x86_64-apple-darwin` (darwin-x64) | build + test + publish prebuild |
| `x86_64-unknown-linux-gnu` (linux-x64 gnu) | build + test + publish prebuild |
| `aarch64-unknown-linux-gnu` (linux-arm64 gnu) | build + publish prebuild (test under QEMU) |
| Windows | **not built** — memwarden explicitly falls back to the TypeScript backend |

Each prebuild job must run the full `test/turbovec-native.test.ts` suite and
`npm run benchmark:backends` (the promotion gate) against its artifact.
musl targets are out of scope until someone needs them; they fall back to
TypeScript like every other unsupported platform.

## Why the default backend stays "typescript"

memwarden defaults to its portable TypeScript index even though the native
backend is dramatically faster (on darwin-arm64: p50 0.15 ms vs 18.9 ms per
search over 10K vectors at identical 1-recall@10). The default only flips
when the benchmark gate — recall drop <= 2 points vs FP32, allowlist purity,
add/remove/save/load id-set parity — passes on **CI-built prebuilds for
every supported platform**, not just on one developer machine. Until then,
opt in per environment:

```sh
MEMWARDEN_VECTOR_BACKEND=turbovec
```

A failed native load is never silent and never lies about the label.

## License

MIT. Statically links the MIT-licensed turbovec crate (c) 2026 Ryan Codrai —
full notices in [LICENSE](./LICENSE).
