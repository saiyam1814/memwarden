# Pinned source-drift study: 2026-08-24-four-repo

**Study size: n=4 repositories. This is a four-repository descriptive result, not a population estimate.**

Generated from the pinned inputs on 2026-08-24T19:27:59.397Z.

## Result

At 30 days, the median substantive drift exposure among recently touched files is **51.2%** across n=3 repositories; the paired random-file median is **5.8%** across n=4 repositories.

At 180 days, the median substantive drift exposure among recently touched files is **61.8%** across n=4 repositories; the paired random-file median is **19.8%** across n=4 repositories.

The recently-touched arm is intentionally paired with a uniform-random file arm. The gap describes attention/churn selection; publishing the touched arm alone would omit the control.

## Non-claim

**Source drift is revalidation exposure. This study never observes a memory, recall, wrong answer, or semantic falsehood, so it is not a measured wrong-memory rate.** A changed file can leave a recorded fact true, and an unchanged file can be affected by changes elsewhere. The rates below measure files requiring re-examination, not false memories or agent error.

## Exact repository identities

| Repository | URL | Pinned HEAD SHA |
| --- | --- | --- |
| django | https://github.com/django/django.git | `0b40210e4808937a7c0922e8b7502bff4752faa3` |
| fastapi | https://github.com/fastapi/fastapi.git | `c3f316b7e814667e8ee81e03a7330d00ee61e45c` |
| react | https://github.com/facebook/react.git | `bd6ea412c6732b3b946a2827fcaac3a1c8f2e863` |
| vite | https://github.com/vitejs/vite.git | `c32e784c95b51f7969cebc7522a5037f14fb6606` |

## Primary analysis: `primary`

Localized documentation is excluded in the primary run.

### Across repositories

| Age | Recently touched median | Touched included/excluded | Random median | Random included/excluded |
| ---: | ---: | --- | ---: | --- |
| 7d | 16.2% | n=3 repos; excluded fastapi (n=13) | 0.5% | n=4 repos; excluded none |
| 30d | 51.2% | n=3 repos; excluded fastapi (n=15) | 5.8% | n=4 repos; excluded none |
| 90d | 53.2% | n=2 repos; excluded fastapi (n=23), react (n=21) | 15.4% | n=4 repos; excluded none |
| 180d | 61.8% | n=4 repos; excluded none | 19.8% | n=4 repos; excluded none |
| 365d | 80.0% | n=3 repos; excluded fastapi (n=2) | 40.1% | n=4 repos; excluded none |

Quartiles use R-7 linear interpolation. IQRs are available in `summary.json`; with an even number of repositories, the median is the arithmetic mean of the two middle rates.

### Per-repository arms and exclusions

| Repository | Age | Capture SHA | Touched n | Touched drift exposure | Random n | Random drift exposure | Candidate exclusions touched (i18n/non-source) | Candidate exclusions random (i18n/non-source) | Sweep exclusions touched/random (commits) |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| django | 7d | `c72f5fb4793f2cac66d76e3cbd590499ad85b89e` | 224 | 6.7% | 400 | 0.8% | 0/7 | 0/297 | 0/0 (0) |
| django | 30d | `957d0cee7167757ae221ffde59d2cf0a322e89c7` | 156 | 17.9% | 400 | 5.0% | 0/10 | 0/295 | 0/0 (0) |
| django | 90d | `032549216074d25628a9d63f44767fa1ed801286` | 168 | 44.6% | 400 | 9.5% | 0/0 | 0/292 | 1/0 (1) |
| django | 180d | `169152f8f5ac586e19779faf9943086fe0f416e9` | 64 | 78.1% | 400 | 13.3% | 0/5 | 0/289 | 0/0 (5) |
| django | 365d | `165ad74c578f94f962624a40dff14e1b2e23a1f8` | 77 | 75.3% | 398 | 20.6% | 0/4 | 0/284 | 10/2 (13) |
| fastapi | 7d | `a1fa70d4237d50aae6586a0d9b229df583463d21` | 13 (excluded) | 7.7% | 400 | 0.0% | 12/23 | 1919/30 | 0/0 (0) |
| fastapi | 30d | `255b912928904e3ba5980425a54d6837c8bd1a1c` | 15 (excluded) | 73.3% | 400 | 2.3% | 193/19 | 1918/30 | 0/0 (0) |
| fastapi | 90d | `6cbdde231589f14df19034e528f47216b52eb755` | 23 (excluded) | 69.6% | 400 | 6.8% | 116/9 | 1776/28 | 0/0 (0) |
| fastapi | 180d | `2b476737b8ed6aa8a42acd5a8e912656d08f15de` | 400 | 11.8% | 400 | 8.0% | 1144/5 | 1712/28 | 0/0 (1) |
| fastapi | 365d | `9cf7b70d7b282b0671dbb1a93a4cbc31aac58abe` | 2 (excluded) | 100.0% | 260 | 63.8% | 4/14 | 1313/25 | 0/140 (4) |
| react | 7d | `eb8feb71096eec5c885b2a4c7d8d030d3622f265` | 99 | 16.2% | 400 | 0.3% | 0/7 | 0/4376 | 0/0 (0) |
| react | 30d | `b685b40d870b90a975da28c8d22ecf0ba910b1a1` | 86 | 51.2% | 400 | 6.5% | 0/7 | 0/4381 | 0/0 (0) |
| react | 90d | `75b0945b18f4a60c80c931fd8067d9c715957879` | 21 (excluded) | 42.9% | 400 | 28.0% | 0/15 | 0/4184 | 0/0 (0) |
| react | 180d | `e33071c6142ae5212483a63b87d5d962860e535a` | 110 | 45.5% | 400 | 28.5% | 0/326 | 0/4147 | 0/0 (1) |
| react | 365d | `090777d78a4d61462dc984b9bba169edd3e7c088` | 288 | 86.1% | 400 | 46.5% | 0/55 | 0/4130 | 2/0 (3) |
| vite | 7d | `83ecb2c8059e8ce946a7cc835d4c14ef78aef4fd` | 74 | 60.8% | 400 | 12.3% | 0/6 | 0/489 | 2/0 (3) |
| vite | 30d | `3ac77d9dd742968961af38a5a91ed6b061ceda7d` | 197 | 66.5% | 399 | 16.3% | 0/45 | 0/481 | 4/1 (3) |
| vite | 90d | `b089c2bab9a92543678e07af6997435542d738c5` | 128 | 61.7% | 400 | 21.3% | 0/28 | 0/437 | 0/0 (4) |
| vite | 180d | `521fdc0ced51ddee7f728e6f891f36ebc6c0e1ce` | 62 | 87.1% | 400 | 26.3% | 0/10 | 0/405 | 3/0 (5) |
| vite | 365d | `e899bc7c73a27cdf327875e5d696c50d396a7fc2` | 130 | 80.0% | 398 | 33.7% | 0/45 | 0/339 | 3/2 (7) |

## Sensitivity analysis: `include-i18n`

Localized documentation is included in this sensitivity run.

### Across repositories

| Age | Recently touched median | Touched included/excluded | Random median | Random included/excluded |
| ---: | ---: | --- | ---: | --- |
| 7d | 16.2% | n=3 repos; excluded fastapi (n=24) | 6.5% | n=4 repos; excluded none |
| 30d | 45.3% | n=4 repos; excluded none | 11.4% | n=4 repos; excluded none |
| 90d | 61.7% | n=3 repos; excluded react (n=21) | 24.6% | n=4 repos; excluded none |
| 180d | 74.8% | n=4 repos; excluded none | 27.4% | n=4 repos; excluded none |
| 365d | 80.0% | n=3 repos; excluded fastapi (n=4) | 40.1% | n=4 repos; excluded none |

Quartiles use R-7 linear interpolation. IQRs are available in `summary.json`; with an even number of repositories, the median is the arithmetic mean of the two middle rates.

### Per-repository arms and exclusions

| Repository | Age | Capture SHA | Touched n | Touched drift exposure | Random n | Random drift exposure | Candidate exclusions touched (i18n/non-source) | Candidate exclusions random (i18n/non-source) | Sweep exclusions touched/random (commits) |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| django | 7d | `c72f5fb4793f2cac66d76e3cbd590499ad85b89e` | 224 | 6.7% | 400 | 0.8% | 0/7 | 0/297 | 0/0 (0) |
| django | 30d | `957d0cee7167757ae221ffde59d2cf0a322e89c7` | 156 | 17.9% | 400 | 5.0% | 0/10 | 0/295 | 0/0 (0) |
| django | 90d | `032549216074d25628a9d63f44767fa1ed801286` | 168 | 44.6% | 400 | 9.5% | 0/0 | 0/292 | 1/0 (1) |
| django | 180d | `169152f8f5ac586e19779faf9943086fe0f416e9` | 64 | 78.1% | 400 | 13.3% | 0/5 | 0/289 | 0/0 (5) |
| django | 365d | `165ad74c578f94f962624a40dff14e1b2e23a1f8` | 77 | 75.3% | 398 | 20.6% | 0/4 | 0/284 | 10/2 (13) |
| fastapi | 7d | `a1fa70d4237d50aae6586a0d9b229df583463d21` | 24 (excluded) | 8.3% | 400 | 25.0% | 0/24 | 0/273 | 0/0 (0) |
| fastapi | 30d | `255b912928904e3ba5980425a54d6837c8bd1a1c` | 208 | 39.4% | 400 | 28.7% | 0/19 | 0/274 | 0/0 (0) |
| fastapi | 90d | `6cbdde231589f14df19034e528f47216b52eb755` | 125 | 81.6% | 400 | 46.8% | 0/10 | 0/269 | 0/0 (0) |
| fastapi | 180d | `2b476737b8ed6aa8a42acd5a8e912656d08f15de` | 400 | 71.5% | 400 | 58.8% | 0/5 | 0/263 | 0/0 (1) |
| fastapi | 365d | `9cf7b70d7b282b0671dbb1a93a4cbc31aac58abe` | 4 (excluded) | 100.0% | 280 | 87.1% | 0/15 | 0/251 | 1/120 (4) |
| react | 7d | `eb8feb71096eec5c885b2a4c7d8d030d3622f265` | 99 | 16.2% | 400 | 0.3% | 0/7 | 0/4376 | 0/0 (0) |
| react | 30d | `b685b40d870b90a975da28c8d22ecf0ba910b1a1` | 86 | 51.2% | 400 | 6.5% | 0/7 | 0/4381 | 0/0 (0) |
| react | 90d | `75b0945b18f4a60c80c931fd8067d9c715957879` | 21 (excluded) | 42.9% | 400 | 28.0% | 0/15 | 0/4184 | 0/0 (0) |
| react | 180d | `e33071c6142ae5212483a63b87d5d962860e535a` | 110 | 45.5% | 400 | 28.5% | 0/326 | 0/4147 | 0/0 (1) |
| react | 365d | `090777d78a4d61462dc984b9bba169edd3e7c088` | 288 | 86.1% | 400 | 46.5% | 0/55 | 0/4130 | 2/0 (3) |
| vite | 7d | `83ecb2c8059e8ce946a7cc835d4c14ef78aef4fd` | 74 | 60.8% | 400 | 12.3% | 0/6 | 0/489 | 2/0 (3) |
| vite | 30d | `3ac77d9dd742968961af38a5a91ed6b061ceda7d` | 197 | 66.5% | 399 | 16.3% | 0/45 | 0/481 | 4/1 (3) |
| vite | 90d | `b089c2bab9a92543678e07af6997435542d738c5` | 128 | 61.7% | 400 | 21.3% | 0/28 | 0/437 | 0/0 (4) |
| vite | 180d | `521fdc0ced51ddee7f728e6f891f36ebc6c0e1ce` | 62 | 87.1% | 400 | 26.3% | 0/10 | 0/405 | 3/0 (5) |
| vite | 365d | `e899bc7c73a27cdf327875e5d696c50d396a7fc2` | 130 | 80.0% | 398 | 33.7% | 0/45 | 0/339 | 3/2 (7) |

## Artifact content hashes

| Artifact | Analysis | Storage | SHA-256 | Bytes / rows |
| --- | --- | --- | --- | ---: |
| summary.json | summary | committed | `741f41580d1ace11c0361d97e964e790a7e35ad844b01b5ac69b1237ddb05407` | 75238 bytes |
| microdata.csv | primary | committed | `b387c9b977afa74bae93f47dd85414c37e3b655aeaeb65e430fe0eee1ffbdc08` | 801784 bytes / 10192 rows |
| include-i18n-microdata.csv | include-i18n | committed | `8cb801ae1ce4c867e3c02fc37d8f2c2f8793de2faf49ada9b37db28cb9885abb` | 812738 bytes / 10520 rows |

## Reproduce

The command verifies every origin URL, exact HEAD SHA, full-clone status, and pinned capture SHA before analysis. It never clones or modifies a source repository. A missing checkout, moving HEAD, changed microdata, or changed result exits non-zero instead of reusing the published percentages.

```bash
npm run eval:halflife:artifact -- reproduce eval/results/2026-08-24-four-repo/manifest.json --corpus-root /path/to/halflife-corpus
```
