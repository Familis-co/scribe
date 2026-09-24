# @familis/scribe-tesseract

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
