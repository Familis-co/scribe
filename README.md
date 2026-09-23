# @familis/scribe

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

See `examples/invoice-zod` for a complete Zod profile. The packages deliberately target server
runtimes only; browser and edge bundles are outside the v1 support policy.

The OCR fallback skips visually blank pages after rendering. Profiles can also opt into
field-specific confidence warnings and constrained correction against an explicit candidate list;
no global or probabilistic autocorrection is performed.
