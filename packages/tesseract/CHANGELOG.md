# @familis/scribe-tesseract

## 0.3.0

### Minor Changes

- c3f4bc6: Upscale low-resolution bitmaps before recognition. A bitmap whose `dpi` is below `upscale.targetDpi` (300 by default) is enlarged with a Lanczos kernel by `targetDpi / dpi`, capped at `upscale.maxFactor` (4 by default), before any `preprocess` step, so a 96 DPI image reaches Tesseract at 300 DPI. Bitmaps at or above the target, or without `dpi`, are unchanged, and `upscale: false` turns it off. Token boxes stay normalized to the input bitmap. Every job now passes its density to Tesseract as `user_defined_dpi` and enables `preserve_interword_spaces`, so multi-word values keep their spacing.
- 7d188c5: Add `minWordConfidence` and `dropPunctuationOnly` options to `createTesseractEngine`. `minWordConfidence` (a number from 0 to 1) drops recognized words below that confidence, and `dropPunctuationOnly` drops words with no letter or digit, such as `|`, `'` or `—`, while keeping `N°` and `1/2`. Both are off by default, and the page-level confidence stays Tesseract's own. `OcrResult` gains an optional `droppedTokenCount`, which the Tesseract adapter always reports and which `PageDiagnostic` surfaces per page, summed across OCR regions.

### Patch Changes

- Updated dependencies [4e9cffc]
- Updated dependencies [2883c3a]
- Updated dependencies [e32cb6c]
- Updated dependencies [081a9d3]
- Updated dependencies [7d188c5]
  - @familis/scribe@0.3.0

## 0.2.1

### Patch Changes

- 3a65964: Stop writing a copy of the language data into the working directory. Without `cachePath`, the Tesseract adapter now turns the Tesseract.js cache off (`cacheMethod: "none"`) and reads `languageDataPath` directly; setting `cachePath` keeps the previous caching behaviour.
- 2b91a47: Stop leaking a worker thread on every parse when Tesseract language data is missing. With a local `languageDataPath`, the adapter now checks that each requested `<lang>.traineddata` (or `.traineddata.gz`) file is readable before starting a worker, and rejects with an `OcrError` naming the missing file and the configured path. A worker that still fails to initialize, for example on corrupt data, is no longer retried on every call: the engine remembers the failure per language set, so at most one start leaks. Create a new engine once the data is fixed.
- @familis/scribe@0.2.1

## 0.2.0

### Minor Changes

- 0c1f6c1: Add `preprocess` and `pageSegMode` options to `createTesseractEngine`. `preprocess.threshold` binarizes each page bitmap at the given gray level (an integer from 0 to 255) and `preprocess.sharpen` applies a mild sharpen, both before PNG encoding. `pageSegMode` sets Tesseract's page segmentation mode on every worker, and `PSM` is re-exported from the adapter. All defaults keep the previous behaviour.
- a53e338: Add a `compressed` option to `createTesseractEngine`. It defaults to `true`, which keeps reading `<lang>.traineddata.gz`; set it to `false` to use a directory of plain `<lang>.traineddata` files.

  A language file that is missing or cannot be opened now rejects `recognize` with `OcrError` instead of crashing the process from inside Tesseract.js. A pool that fails to start is no longer cached, so the next call for that language set tries again.

### Patch Changes

- Updated dependencies [2abd0e4]
- Updated dependencies [93853d1]
- Updated dependencies [1e4e9bc]
- Updated dependencies [b9ed5f9]
- Updated dependencies [1ab5c61]
  - @familis/scribe@0.2.0
