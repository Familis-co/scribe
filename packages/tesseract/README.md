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

When `languageDataPath` is a local directory, the adapter checks that every requested language file
exists and is readable before it starts a worker. A missing file rejects `recognize` with `OcrError`,
whose message names the file and the configured path. Remote locations are left to Tesseract.js: a
file it cannot fetch also rejects with `OcrError`, whose `cause` carries the Tesseract.js report.

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

| Option             | Required | Description                                                                        |
| ------------------ | -------- | ---------------------------------------------------------------------------------- |
| `languageDataPath` | Yes      | Local path or explicitly configured Tesseract.js language-data location.           |
| `compressed`       | No       | Whether language files are gzipped (`.traineddata.gz`). Defaults to `true`.        |
| `cachePath`        | No       | Writable directory for the language-data cache. Omitted, no cache is used.         |
| `workerPath`       | No       | Custom Tesseract.js worker script location.                                        |
| `corePath`         | No       | Custom Tesseract.js core/WASM location.                                            |
| `concurrency`      | No       | Number of OCR workers per language set. Defaults to `1`.                           |
| `logger`           | No       | Receives Tesseract.js progress messages.                                           |
| `preprocess`       | No       | `{ threshold, sharpen }` image adjustments before recognition. All off by default. |
| `pageSegMode`      | No       | Tesseract page segmentation mode (`PSM`). Defaults to Tesseract's `PSM.AUTO`.      |

Without `cachePath`, Tesseract.js reads `languageDataPath` directly and writes nothing. Setting it
makes Tesseract.js keep a copy of each language it loads there and read it back on later starts.
That only pays off with a remote `languageDataPath`: with a local directory, the cache copies one
local file to another.

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

## Preprocessing and page segmentation

By default the bitmap reaches Tesseract as rendered, and Tesseract picks its own page layout. Two
options change that:

```ts
import { createTesseractEngine, PSM } from "@familis/scribe-tesseract";

const ocr = await createTesseractEngine({
  languageDataPath: "/opt/tessdata",
  preprocess: {
    threshold: 160, // binarize: gray levels >= 160 become white, the rest black
    sharpen: false,
  },
  pageSegMode: PSM.SINGLE_BLOCK,
});
```

- `preprocess.threshold` binarizes the image before PNG encoding. It helps with low-resolution
  bitmap text, such as a 96 DPI header embedded in a PDF, where gray anti-aliasing blurs digits
  together. It must be an integer from `0` to `255`; `null` or omitted leaves the image untouched.
  Too high a cutoff thins or breaks light strokes, too low a cutoff merges them, so tune it against
  your own documents.
- `preprocess.sharpen` applies a mild sharpen. It runs before thresholding when both are set.
- `pageSegMode` tells Tesseract how the image is laid out. `PSM.AUTO` suits full pages;
  `PSM.SINGLE_BLOCK` or `PSM.SINGLE_LINE` suit a cropped region holding one block or one line of
  text. `PSM` is re-exported, so there is no need to import Tesseract.js directly.

These settings apply to every page the engine recognizes. Measure them on representative documents
before enabling them: they help degraded bitmap text and can hurt clean scans.

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

A missing local language file is checked again on every call, so data deployed after the failure is
picked up without a restart, and no worker is started until it is there.

Other initialization failures, such as corrupt or unreachable language data, happen inside a worker.
Tesseract.js offers no way to terminate a worker whose language data failed to load, so its thread
stays idle and keeps Node.js from exiting on its own. To keep that to one failed start per language
set, the engine remembers the failure: later calls for the same languages reject with the same
`OcrError` without starting new workers. Fix the configuration and create a new engine to retry.

## Container deployment

No system `tesseract-ocr` executable is required. Install dependencies inside the target Linux
image so Sharp selects the correct platform binary, and copy language data into the image. With
local language data, leave `cachePath` unset: no writable directory is needed.

```dockerfile
ENV TESSDATA_PATH=/opt/familis/tessdata

COPY resources/tessdata/ /opt/familis/tessdata/
```

Do not copy `node_modules` from macOS or Windows into a Linux image.

## Runtime support

- Node.js 22.12 or newer.
- Current stable Bun.
- Server runtimes only; browser and edge use are not supported in v1.

## License

MIT
