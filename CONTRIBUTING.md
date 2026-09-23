# Contributing

Thanks for helping out. This repository is a pnpm workspace holding three published packages:

- `@familis/scribe` in `packages/core` — the engine-independent pipeline, the profile DSL and the
  `@familis/scribe/testing` adapter contract checks
- `@familis/scribe-pdfium` in `packages/pdfium` — the PDFium adapter
- `@familis/scribe-tesseract` in `packages/tesseract` — the Tesseract.js OCR adapter

The `examples/` workspaces are private and only exist to show and type-check real usage.

Taking part means following the [Code of Conduct](.github/CODE_OF_CONDUCT.md). Found a
vulnerability? Do not open an issue — the [security policy](.github/SECURITY.md) explains how to
report it privately.

## Getting set up

```bash
pnpm install
```

That installs the workspace and lets Lefthook install the git hooks. Node 22.12 or later is
required, `.nvmrc` pins the Node line, and the `packageManager` field in `package.json` pins the
pnpm version.

The test suite mocks Tesseract.js, so no language data is needed to run it. The examples do need
it: point `TESSDATA_PATH` at a directory of `.traineddata` files to run them against a real PDF.

## Working on a change

`main` stays deployable, so work happens on a branch cut from it:

```bash
git switch -c feature/iban-transform
```

Branch names are `feature/…`, `fix/…` or `docs/…`, and a branch, a pull request and a commit should
each carry one logical change.

While you work:

```bash
pnpm test:watch    # vitest in watch mode
pnpm deps:check    # list outdated dependencies
```

Before opening a pull request, run the same gate CI runs:

```bash
pnpm check
```

It chains `format:check`, `lint`, `docs:check`, `build`, `typecheck`, `test` and `packages:check`.
The last one packs every package and imports the tarballs from ESM and CommonJS in an isolated
project, which catches missing files and broken `exports` before a release does.

The pre-commit hook runs Oxfmt and Oxlint over the staged files, and the pre-push hook runs the
typecheck and the tests, so most of this happens for you.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add an IBAN transform
fix(pdfium): keep ligatures inside a single token
docs: explain anchor offsets
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`. The scope is usually `core`, `pdfium`, `tesseract` or `examples`.

## Changesets

Anything that changes published behaviour needs a changeset:

```bash
pnpm changeset
```

Pick the bump level, then describe the change from the user's point of view — that text becomes the
changelog entry. Commit the generated file in `.changeset/` along with your work. The three packages
are versioned together, so one changeset covers the whole release.

When the pull request lands on `main`, the release workflow opens a version pull request. Merging
that publishes the packages.

## Extending Scribe

- New transforms go into the `TransformDefinition` union and the `transform` builders in
  `packages/core/src/profile.ts`, with their behaviour in `applyTransforms` in
  `packages/core/src/extract.ts`. Transforms must stay deterministic: no probabilistic or global
  autocorrection.
- New selectors follow the same path through `TextSelector`, the `select` builders and
  `tokensForSelector`.
- New public errors extend `ScribeError`, get a `ScribeErrorCode` and join the `AnyScribeError`
  union in `packages/core/src/errors.ts`.
- A new PDF or OCR adapter implements `PdfEngine` or `OcrEngine` from `@familis/scribe` and runs
  `verifyPdfEngineContract` or `verifyOcrEngineContract` from `@familis/scribe/testing` in its tests.
  Its `close()` must be idempotent.
- Every function, method and constructor carries TSDoc covering each parameter. `pnpm docs:check`
  rejects malformed comments.

## Test documents

Never commit a real customer document, even redacted. Build fixtures programmatically, as
`packages/pdfium/test/fixture.ts` does, or render synthetic documents with fictitious data.

## Opening an issue

Issues go through a form, so pick the one that fits:

- **Bug report** — a package does not behave the way it is documented. The form asks for the
  package, a reproduction, the diagnostics Scribe returned and the versions involved.
- **Feature request** — a transform, selector, adapter option or API Scribe does not cover yet.

Questions about how to use Scribe belong in
[Discussions](https://github.com/Familis-co/scribe/discussions). Problems inside PDFium or
Tesseract themselves belong upstream.

## Writing a pull request

Opening one fills in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md). Work through it
rather than deleting it.

Describe _why_ the change is needed, not only what it does. If it changes extraction results, say
which kind of document you verified it against — native text, scanned or mixed — and include the
page diagnostics before and after.
