# @familis/scribe

[![CI](https://github.com/Familis-co/scribe/actions/workflows/ci.yml/badge.svg)](https://github.com/Familis-co/scribe/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Familis-co/scribe)](LICENSE)

A Node.js and Bun monorepo for deterministic PDF text extraction, local OCR, declarative
document profiles, and Standard Schema validation.

## Packages

- [`@familis/scribe`](packages/core/README.md) — engine-independent pipeline, profile DSL,
  validation, diagnostics, and evidence.
- [`@familis/scribe-pdfium`](packages/pdfium/README.md) — positioned native text extraction and
  page rendering with PDFium.
- [`@familis/scribe-tesseract`](packages/tesseract/README.md) — local OCR with reusable
  Tesseract.js workers and Sharp preprocessing.

Install from npm:

```sh
pnpm add @familis/scribe @familis/scribe-pdfium @familis/scribe-tesseract zod
```

The same versions are mirrored to GitHub Packages under the `@familis-co` scope. Install them
through npm aliases so imports keep the `@familis/*` specifiers and the adapters share a single
copy of the core package:

```ini
# .npmrc
@familis-co:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
pnpm add @familis/scribe@npm:@familis-co/scribe \
  @familis/scribe-pdfium@npm:@familis-co/scribe-pdfium \
  @familis/scribe-tesseract@npm:@familis-co/scribe-tesseract zod
```

## Development

```sh
pnpm install
pnpm check
pnpm deps:check
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/); Lefthook runs Oxfmt
and Oxlint on staged files before each commit, then typecheck and tests before a push. See
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and the
[security policy](.github/SECURITY.md) to report a vulnerability.

See `examples/invoice-zod` for a complete Zod profile. The packages deliberately target server
runtimes only; browser and edge bundles are outside the v1 support policy.

The OCR fallback skips visually blank pages after rendering. Profiles can also opt into
field-specific confidence warnings and constrained correction against an explicit candidate list;
no global or probabilistic autocorrection is performed.

## Releasing

Releases are driven by [Changesets](https://changesets.dev) and
[`.github/workflows/release.yml`](.github/workflows/release.yml):

1. Add a changeset to every pull request that changes a published package with `pnpm changeset`.
   The three packages share one version.
2. Every push to `main` first runs the full CI workflow. When changesets are pending, the release
   workflow then opens or updates a `chore: release packages` pull request that bumps versions and
   writes changelogs.
3. Merging that pull request runs CI again, packs the tarballs once, publishes them to npm
   through trusted publishing with provenance, creates the Git tags and GitHub releases, then
   mirrors the same tarballs to GitHub Packages.

One-time repository setup:

- In `Settings > Actions > General`, allow GitHub Actions to create and approve pull requests.
- Publish the first version of each package to npm manually (`pnpm release` with an npm account
  that owns the `@familis` scope), because npm only accepts trusted publishers on existing
  packages.
- For each package on npmjs.com, add a GitHub Actions trusted publisher for the `Familis-co/scribe`
  repository, the `release.yml` workflow, and the `npm` environment. Then set publishing access to
  require two-factor authentication and disallow tokens.
- Optionally add required reviewers to the `npm` environment in `Settings > Environments` to gate
  every publication.
