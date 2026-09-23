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

All three packages are configured for public npm publication:

```sh
pnpm add @familis/scribe @familis/scribe-pdfium @familis/scribe-tesseract zod
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
