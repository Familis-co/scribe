# @familis/scribe-tesseract

Local OCR adapter for `@familis/scribe`, backed by Tesseract.js and Sharp. It accepts page bitmaps,
prepares PNG input, reuses OCR workers, and returns normalized positioned tokens.

Tesseract.js does not read PDF files directly. Use a PDF adapter such as
`@familis/scribe-pdfium` to render pages first.

## Installation

```sh
pnpm add @familis/scribe @familis/scribe-tesseract
```

## Language data

`languageDataPath` is required. Point it to an explicitly configured Tesseract.js-compatible
language-data location. A local directory is recommended for production:

```text
/opt/familis/tessdata/
├── eng.traineddata.gz
└── fra.traineddata.gz
```

By default the adapter reads gzipped `<lang>.traineddata.gz` files. For a directory of plain
`<lang>.traineddata` files, the layout tessdata is distributed in, set `compressed: false`:

```text
/opt/tessdata/
├── eng.traineddata
└── fra.traineddata
```

```ts
const ocr = await createTesseractEngine({
  languageDataPath: "/opt/tessdata",
  compressed: false,
});
```

A language file that is missing or cannot be read rejects `recognize` with `OcrError`, whose `cause`
names the file Tesseract.js tried to open.

The adapter never selects a remote language-data source or automatically detects a language. Every
document profile must declare its languages.

## Usage

```ts
import { createScribe } from "@familis/scribe";
import { createPdfiumEngine } from "@familis/scribe-pdfium";
import { createTesseractEngine } from "@familis/scribe-tesseract";

const scribe = createScribe({
  pdf: await createPdfiumEngine(),
  ocr: await createTesseractEngine({
    languageDataPath: "/opt/familis/tessdata",
    cachePath: "/var/cache/familis-scribe",
    concurrency: 1,
  }),
});

try {
  const result = await scribe.parse(bytes, profile, { ocr: "auto" });
  console.log(result.data);
} finally {
  await scribe.close();
}
```

## Options

| Option             | Required | Description                                                                 |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `languageDataPath` | Yes      | Local path or explicitly configured Tesseract.js language-data location.    |
| `compressed`       | No       | Whether language files are gzipped (`.traineddata.gz`). Defaults to `true`. |
| `cachePath`        | No       | Writable Tesseract.js cache directory.                                      |
| `workerPath`       | No       | Custom Tesseract.js worker script location.                                 |
| `corePath`         | No       | Custom Tesseract.js core/WASM location.                                     |
| `concurrency`      | No       | Number of OCR workers per language set. Defaults to `1`.                    |
| `logger`           | No       | Receives Tesseract.js progress messages.                                    |

```ts
const ocr = await createTesseractEngine({
  languageDataPath: "/opt/tessdata",
  logger(message) {
    console.log(message.status, message.progress);
  },
});
```

## Worker reuse and concurrency

Workers are pooled by normalized language set. Requests for `["fra", "eng"]` and
`["eng", "fra"]` reuse the same pool.

`concurrency` controls the number of workers in each pool. Each application process or container
creates its own pools, so total OCR concurrency is:

```text
application processes × language sets used × configured concurrency
```

Start with `concurrency: 1` and increase it only after measuring CPU and memory consumption. Use an
application-level queue or request limit when many documents can arrive simultaneously.

## Image preparation

The adapter accepts the core `PageBitmap` contract:

```ts
interface PageBitmap {
  data: Uint8Array;
  width: number;
  height: number;
  format: "gray8" | "rgba8";
  dpi?: number;
}
```

Sharp converts the raw bitmap to PNG. When `dpi` is present, it is written into the PNG metadata;
otherwise the adapter uses 300 DPI. OCR tokens are normalized to top-left coordinates between `0`
and `1`, with confidence values between `0` and `1`.

The standard PDFium adapter supplies the requested render density. The core pipeline renders OCR
pages in grayscale at 300 DPI and skips visually blank pages before invoking this adapter.

## Languages

Languages come from the active profile:

```ts
const profile = defineProfile({
  id: "multilingual-document",
  version: "1",
  languages: ["fra", "eng"],
  schema,
  fields,
});
```

All declared language files must be available beneath `languageDataPath` using the layout expected
by Tesseract.js.

## Direct engine usage

```ts
const result = await ocr.recognize(bitmap, {
  languages: ["fra"],
  signal,
});

console.log(result.tokens, result.confidence);
await ocr.close();
```

`close()` terminates every initialized scheduler and worker. It is idempotent.

## Errors and cancellation

- Initialization and recognition failures produce `OcrError`.
- Missing languages produce `OcrError`.
- An already aborted operation, or an abort while awaiting recognition, produces `AbortError`.
- Calling the engine after `close()` produces `DisposedError`.

An abort rejects the caller immediately. Tesseract.js work already executing inside a worker may
finish internally before that worker accepts another job.

A pool that fails to initialize is not kept: the next call for the same language set starts new
workers, so language data added after the failure is picked up without a restart. Tesseract.js
offers no way to terminate a worker whose language data failed to load, though, so each failed
start leaves its worker threads idle and keeps Node.js from exiting on its own. Treat the
`OcrError` as a configuration problem to fix rather than a call to retry in a loop.

## Container deployment

No system `tesseract-ocr` executable is required. Install dependencies inside the target Linux
image so Sharp selects the correct platform binary, copy language data into the image, and provide a
writable cache directory.

```dockerfile
ENV TESSDATA_PATH=/opt/familis/tessdata
ENV SCRIBE_CACHE_PATH=/var/cache/familis-scribe

COPY resources/tessdata/ /opt/familis/tessdata/
RUN mkdir -p /var/cache/familis-scribe \
  && chown -R node:node /opt/familis /var/cache/familis-scribe
```

Do not copy `node_modules` from macOS or Windows into a Linux image.

## Runtime support

- Node.js 22.12 or newer.
- Current stable Bun.
- Server runtimes only; browser and edge use are not supported in v1.

## License

MIT
