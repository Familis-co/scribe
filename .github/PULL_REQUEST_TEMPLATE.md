## Why

<!-- What problem does this solve? Link the issue it closes: "Closes #123". -->

## What changed

<!-- The shape of the change, not a file-by-file replay of the diff. -->

## Surface

<!-- Tick every package this touches. -->

- [ ] `@familis/scribe` — pipeline, profile DSL, validation or errors
- [ ] `@familis/scribe/testing` — adapter contract checks
- [ ] `@familis/scribe-pdfium` — PDFium adapter
- [ ] `@familis/scribe-tesseract` — Tesseract.js adapter
- [ ] Examples, build, CI or repository tooling only

## Testing

<!--
Which tests cover this. If extraction results change, say which kind of document
you verified against (native text, scanned or mixed) and paste the page
diagnostics before and after. Never attach a real customer document.
-->

## Checklist

- [ ] The branch is cut from `main` and carries one logical change
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] `pnpm check` passes
- [ ] Every new function, method and constructor carries TSDoc
- [ ] A changeset is included (`pnpm changeset`), or the change does not alter published behaviour
- [ ] Breaking changes are called out below

## Breaking changes

<!-- Delete this section if there are none. Otherwise: what breaks, and how to migrate. -->
