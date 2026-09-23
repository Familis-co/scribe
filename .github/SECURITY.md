# Security policy

## Supported versions

The `@familis/scribe` packages are pre-1.0 and versioned together. Only the latest published minor
receives security fixes; there are no backports to earlier lines.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

Report privately through a
[GitHub security advisory](https://github.com/Familis-co/scribe/security/advisories/new). Please
do not open a public issue, and do not describe the problem in a pull request.

Include what you can of:

- the package involved — `@familis/scribe`, `@familis/scribe-pdfium` or `@familis/scribe-tesseract`
- the package version and the runtime it was reproduced on, Node or Bun
- a proof of concept; when it needs a PDF, a synthetic one rather than a real document
- what an attacker gains

You can expect an acknowledgement within a week. Once a fix ships, the advisory is published and
credits you unless you would rather stay anonymous.

## Scope

Scribe is built to process PDFs from untrusted sources on a server. This policy covers its own
code, in particular:

- resource limits that can be bypassed — `maxBytes`, `maxPages`, `maxPixelsPerPage` and
  `concurrency` exist to bound memory and CPU per parse
- cancellation that leaves work running after an `AbortSignal` fires, beyond the documented
  Tesseract.js limitation
- memory or worker leaks after `close()`, which matter for long-lived processes
- extracted text or evidence leaking between parses that share a `Scribe` instance

Two things sit outside it:

- **PDFium, Tesseract.js and Sharp themselves.** Report those upstream, to
  [PDFium](https://pdfium.googlesource.com/pdfium/),
  [`@embedpdf/pdfium`](https://github.com/embedpdf/embed-pdf-viewer),
  [Tesseract.js](https://github.com/naptha/tesseract.js) or
  [Sharp](https://github.com/lovell/sharp). If Scribe exposes one of their flaws in a way it
  should prevent, report it here too.
- **Configuration you control.** `languageDataPath`, `workerPath` and `corePath` are trusted
  inputs: pointing them at a location someone else can write to lets that party run code in the
  OCR workers. Keep limits in place for untrusted uploads and run parsing in a process you can
  restart.
