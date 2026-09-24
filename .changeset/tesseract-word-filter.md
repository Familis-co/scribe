---
"@familis/scribe": minor
"@familis/scribe-tesseract": minor
---

Add `minWordConfidence` and `dropPunctuationOnly` options to `createTesseractEngine`. `minWordConfidence` (a number from 0 to 1) drops recognized words below that confidence, and `dropPunctuationOnly` drops words with no letter or digit, such as `|`, `'` or `—`, while keeping `N°` and `1/2`. Both are off by default, and the page-level confidence stays Tesseract's own. `OcrResult` gains an optional `droppedTokenCount`, which the Tesseract adapter always reports and which `PageDiagnostic` surfaces per page, summed across OCR regions.
