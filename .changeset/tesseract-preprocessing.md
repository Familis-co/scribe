---
"@familis/scribe-tesseract": minor
---

Add `preprocess` and `pageSegMode` options to `createTesseractEngine`. `preprocess.threshold` binarizes each page bitmap at the given gray level (an integer from 0 to 255) and `preprocess.sharpen` applies a mild sharpen, both before PNG encoding. `pageSegMode` sets Tesseract's page segmentation mode on every worker, and `PSM` is re-exported from the adapter. All defaults keep the previous behaviour.
