---
"@familis/scribe-tesseract": minor
---

Upscale low-resolution bitmaps before recognition. A bitmap whose `dpi` is below `upscale.targetDpi` (300 by default) is enlarged with a Lanczos kernel by `targetDpi / dpi`, capped at `upscale.maxFactor` (4 by default), before any `preprocess` step, so a 96 DPI image reaches Tesseract at 300 DPI. Bitmaps at or above the target, or without `dpi`, are unchanged, and `upscale: false` turns it off. Token boxes stay normalized to the input bitmap. Every job now passes its density to Tesseract as `user_defined_dpi` and enables `preserve_interword_spaces`, so multi-word values keep their spacing.
