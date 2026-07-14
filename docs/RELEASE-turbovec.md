# Releasing @memwarden/turbovec (manual)

The `turbovec-release` workflow BUILDS and VALIDATES the native binding for every
platform (build, native tests, promotion benchmark, clean-container load gate)
and uploads each platform's `*.node` as an artifact. It does NOT auto-publish,
because npm's "2FA for writes" account setting demands an interactive OTP that CI
cannot provide. Publishing is a short manual step where you enter the OTP.

## Publish (all platforms, from a green build run)

```bash
# 0. be logged in (opens a browser / prompts OTP)
npm whoami || npm login

# 1. download every platform's binary from a GREEN turbovec-release run
#    (find the run id with: gh run list --workflow turbovec-release)
gh run download <RUN_ID> --repo saiyam1814/memwarden --dir /tmp/tv --pattern "binding-*"

# 2. drop all three binaries into the package (replaces any stale local one)
cp /tmp/tv/binding-*/*.node native/turbovec-node/
ls -1 native/turbovec-node/*.node
#    expect three: darwin-arm64, darwin-x64, linux-x64-gnu

# 3. publish — index.js/index.d.ts are generated at build time and committed-adjacent;
#    enter your OTP when prompted. --access public is required for a new scoped pkg.
cd native/turbovec-node && npm publish --access public

# 4. verify
npm view @memwarden/turbovec version      # -> 0.1.5
npm view @memwarden/turbovec              # confirm the .node files are in the tarball
```

If `index.js` / `index.d.ts` are missing locally, regenerate them (Rust required):
`cd native/turbovec-node && npm ci && npx napi build --release --platform`, then
re-copy the CI `.node` files over the local one and publish.

## After the first publish: go token-free

Once the package exists, configure **Trusted Publishing** on npmjs.com
(package -> Settings -> Trusted Publishing -> GitHub Actions -> repo
`saiyam1814/memwarden`, workflow `turbovec-release.yml`), restore the `publish`
job to the workflow, and you can auto-publish via OIDC with no token and no OTP -
and set account 2FA back to "Authorization and writes".
