# @familis/scribe

Engine-independent structured PDF extraction for Node.js and Bun. The package coordinates native
text extraction, selective OCR, declarative field extraction, evidence collection, and Standard
Schema validation.

It does not include a PDF or OCR implementation. Install the adapters you need separately.

## Features

- Declarative profiles for documents that share a layout.
- Fixed-region, anchor-relative and line-scoped anchor selectors using normalized coordinates.
- Scalar, nested, and repeated fields, with ordered fallbacks between strategies.
- Regex captures and built-in transformations.
- Standard Schema validation, including asynchronous validators and Zod 4.
- Selective OCR with per-page diagnostics.
- Field-level evidence containing source text, coordinates, method, and confidence.
- `Promise` and `AbortSignal` APIs with discriminated errors.
- Replaceable PDF and OCR engines.

## Installation

```sh
pnpm add @familis/scribe zod
```

For the standard local stack:

```sh
pnpm add @familis/scribe-pdfium @familis/scribe-tesseract
```

`zod` is used by the examples but is not a runtime dependency of this package. Any Standard Schema
compatible validator can be used.

## Quick start

```ts
import { readFile } from "node:fs/promises";
import { createScribe, defineProfile, field, select, transform } from "@familis/scribe";
import { createPdfiumEngine } from "@familis/scribe-pdfium";
import { createTesseractEngine } from "@familis/scribe-tesseract";
import { z } from "zod";

const invoiceProfile = defineProfile({
  id: "invoice",
  version: "1",
  languages: ["fra"],
  schema: z.object({
    number: z.string(),
    total: z.number().nonnegative(),
  }),
  fields: {
    number: field.text({
      select: select.relativeToAnchor({
        text: /facture\s*(?:n°|no)?/iu,
        offset: { x: 0.18, y: -0.01, width: 0.3, height: 0.06 },
      }),
      transforms: [transform.normalizeWhitespace()],
    }),
    total: field.text({
      select: select.relativeToAnchor({
        text: /total\s+ttc/iu,
        offset: { x: 0.2, y: -0.01, width: 0.3, height: 0.06 },
      }),
      pattern: /([\d\s]+,\d{2})/u,
      group: 1,
      transforms: [
        transform.number({
          decimalSeparator: ",",
          groupSeparators: [" ", "\u00a0"],
        }),
      ],
    }),
  },
});

const scribe = createScribe({
  pdf: await createPdfiumEngine(),
  ocr: await createTesseractEngine({
    languageDataPath: "/opt/tessdata",
    cachePath: "/var/cache/scribe",
  }),
});

try {
  const result = await scribe.parse(await readFile("invoice.pdf"), invoiceProfile, {
    ocr: "auto",
  });

  console.log(result.data);
  console.log(result.evidence["/total"]);
} finally {
  await scribe.close();
}
```

`createScribe` is synchronous. The standard adapters are asynchronous to create.

## Profiles

Every profile declares:

- a stable `id` and `version`;
- at least one OCR language;
- a Standard Schema validator;
- a field tree matching the desired output structure.

Profiles are TypeScript objects. Functions and regular expressions are supported, so profiles are
not JSON serializable.

### Coordinates and pages

All boxes use normalized coordinates from `0` to `1`, with the origin at the top-left:

```ts
{ x: 0.1, y: 0.2, width: 0.4, height: 0.08 }
```

A page selector can be `"any"`, `"first"`, `"last"`, or a one-based page number.

### Selectors

Select a fixed region:

```ts
select.region({ x: 0.1, y: 0.2, width: 0.4, height: 0.08 }, 1);
```

Select a region relative to a text anchor:

```ts
select.relativeToAnchor({
  text: /invoice number/iu,
  page: "first",
  occurrence: 0,
  offset: { x: 0.15, y: -0.01, width: 0.3, height: 0.06 },
});
```

The offset starts at the anchor's top-left position. Its width and height remain normalized page
dimensions.

Select the value printed after a label on the same line:

```ts
select.afterAnchor({
  text: /Concerne\s*:/iu,
  stopAt: /Date\s*:/iu, // optional
  page: 1, // default "any"
  occurrence: 0, // default 0
});
```

`afterAnchor` selects the tokens on the anchor's visual line that sit to the right of the anchor's
last token. It stops before the first token where `stopAt` matches, so a second label on the same
line (`Reference: 1234567  Concerne: …`) is left out. Unlike a fixed offset box, it never catches the
start of the next line when OCR boxes shift vertically. `page` and `occurrence` behave as in
`relativeToAnchor`, and literal `text` and `stopAt` values ignore case unless `caseSensitive` is set.

### Fields and captures

`field.text` returns a single value. `field.list` applies a repeated capture and returns an array.

```ts
field.list({
  select: select.region({ x: 0.1, y: 0.3, width: 0.8, height: 0.4 }, 1),
  pattern: /item:\s*([^\n]+)/giu,
  group: 1,
  transforms: [transform.trim()],
});
```

Fields are required by default. Set `required: false` for optional fields or provide a
`defaultValue`.

### Fallback strategies

`field.firstOf` tries several strategies in order: the precise one first, then looser ones when it
fails.

```ts
const digitsOnly = transform.custom("digitsOnly", (value) => {
  const digits = String(value).replace(/\D/gu, "");
  if (digits.length !== 10) throw new TypeError(`Expected 10 digits, got ${digits.length}.`);
  return digits;
});

dossier: field.firstOf(
  [
    field.text({
      select: select.afterAnchor({ text: /Reference\s*:/iu }),
      transforms: [digitsOnly],
    }),
    field.text({
      select: select.region({ x: 0, y: 0.2, width: 1, height: 0.2 }, 1),
      pattern: /Ref\w*\s*[:.]?\s*(\d{4,})/iu,
      group: 1,
      transforms: [digitsOnly],
    }),
  ],
  { required: true, warnBelowConfidence: 0.8 },
);
```

The first alternative that captures a value **and** whose transforms all succeed wins. A transform
that throws rejects that reading and moves on to the next alternative, which is how a strategy says
"this is not a valid value".

`required`, `defaultValue` and `warnBelowConfidence` belong to the `firstOf` wrapper; the
alternatives' own values are ignored. Evidence records the winning alternative's index as
`alternative`, and an info diagnostic `FALLBACK_USED` explains why earlier alternatives failed. When
every alternative fails on a required field, `parse` rejects with an `ExtractionError` naming the
field's pointer.

### Built-in transforms

| Transform                           | Purpose                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `trim()`                            | Remove leading and trailing whitespace.                  |
| `normalizeWhitespace()`             | Collapse whitespace and trim the result.                 |
| `replace(search, replacement)`      | Replace text using a string or regular expression.       |
| `number(options)`                   | Parse a localized number.                                |
| `date(format, output)`              | Parse a date as ISO text or a `Date`.                    |
| `closestMatch(candidates, options)` | Select a unique nearby explicit candidate.               |
| `custom(name, map)`                 | Run a synchronous or asynchronous application transform. |

Transforms run from left to right.

## OCR confidence and constrained correction

Use `warnBelowConfidence` to keep a value while emitting a warning when its selected OCR region is
uncertain:

```ts
const person = field.text({
  select: select.region({ x: 0.1, y: 0.2, width: 0.5, height: 0.08 }, 1),
  warnBelowConfidence: 0.9,
  transforms: [
    transform.closestMatch(knownPeople, {
      maxDistance: 1,
      ignoreCase: true,
      ignoreDiacritics: true,
    }),
  ],
});
```

`closestMatch` only replaces the value when one candidate is uniquely closest and within
`maxDistance`. Ambiguous and distant values are unchanged. This makes it suitable for an explicit
business reference list, but not for guessing unknown names.

A value's confidence is the **lowest** OCR confidence among the tokens it was read from, so one
uncertain character in an identifier is enough to raise a warning. With a `pattern`, only the tokens
overlapping the captured group count: a misread date inside a well-read sentence is flagged on its
own merits instead of inheriting the sentence's confidence. Without a `pattern`, every selected
token counts. Native tokens carry no confidence.

A low-confidence value produces a `LOW_FIELD_CONFIDENCE` diagnostic. For `field.list`, each value
is scored separately and the diagnostic points at the item, such as `/codes/1`. Evidence retains
the raw OCR text even if the validated data contains a corrected candidate; its `box` and `text`
cover the tokens behind the captured value, and a list has one evidence entry per value.

## OCR modes

Pass an OCR policy to `parse`:

```ts
await scribe.parse(bytes, profile, { ocr: "auto", signal });
```

| Mode     | Behavior                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| `auto`   | Extract native text first, then OCR pages with insufficient text or unresolved required fields. This is the default. |
| `always` | Render every non-blank page and use OCR tokens.                                                                      |
| `never`  | Use native PDF text only.                                                                                            |

Blank rendered pages are not sent to the OCR engine. OCR tokens replace native tokens for a page;
the two sources are not merged blindly.

## Result and evidence

```ts
interface ExtractionResult<T> {
  data: T;
  evidence: Record<JsonPointer, FieldEvidence[]>;
  pages: PageDiagnostic[];
  diagnostics: Diagnostic[];
}
```

Evidence keys are JSON pointers such as `/customer/name`. Each item reports the page, bounding box,
raw text, `native` or `ocr` method, optional confidence, and transformations applied.

Page diagnostics report native character counts, final token counts, timing, OCR confidence, and
whether OCR was skipped for a blank page.

## Limits

Defaults can be overridden during construction:

```ts
const scribe = createScribe({
  pdf,
  ocr,
  limits: {
    maxBytes: 50 * 1024 * 1024,
    maxPages: 100,
    maxPixelsPerPage: 25_000_000,
    concurrency: 1,
  },
});
```

`concurrency` limits page work within a parse operation. Applications accepting many simultaneous
documents should also use request throttling or a job queue.

## Errors

All library errors extend `ScribeError` and expose a stable `code`:

| Error                | Code               |
| -------------------- | ------------------ |
| `InvalidPdfError`    | `INVALID_PDF`      |
| `EncryptedPdfError`  | `ENCRYPTED_PDF`    |
| `LimitExceededError` | `LIMIT_EXCEEDED`   |
| `PdfEngineError`     | `PDF_ENGINE_ERROR` |
| `OcrError`           | `OCR_ERROR`        |
| `ExtractionError`    | `EXTRACTION_ERROR` |
| `ValidationError`    | `VALIDATION_ERROR` |
| `AbortError`         | `ABORTED`          |
| `DisposedError`      | `DISPOSED`         |

```ts
import { ScribeError } from "@familis/scribe";

try {
  await scribe.parse(bytes, profile);
} catch (error) {
  if (error instanceof ScribeError) {
    console.error(error.code, error.message);
  }
}
```

`ValidationError` includes normalized issues and the raw intermediate value. `ExtractionError`
contains the missing JSON pointer paths.

## Lifecycle

Call `close()` during application shutdown. It closes both configured engines and is idempotent.
Parsing after closure throws `DisposedError`.

## Custom adapters and contract tests

Implement `PdfEngine` or `OcrEngine` to replace the standard adapters. Reusable contract helpers
are available from the testing export:

```ts
import { verifyOcrEngineContract, verifyPdfEngineContract } from "@familis/scribe/testing";
```

## Runtime support

- Node.js 22.12 or newer.
- Current stable Bun.
- Server runtimes only.
- Browsers, edge runtimes, and React Native are not supported in v1.

## License

MIT
