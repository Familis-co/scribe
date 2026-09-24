---
"@familis/scribe-tesseract": minor
---

Add a `compressed` option to `createTesseractEngine`. It defaults to `true`, which keeps reading `<lang>.traineddata.gz`; set it to `false` to use a directory of plain `<lang>.traineddata` files.

A language file that is missing or cannot be opened now rejects `recognize` with `OcrError` instead of crashing the process from inside Tesseract.js. A pool that fails to start is no longer cached, so the next call for that language set tries again.
