---
"@familis/scribe": minor
---

Profiles can declare `ocr.regions`, the only page areas ever sent to the OCR engine. Each page is rendered once, every region is cropped out of the render, and the recognized tokens are mapped back to page coordinates and merged with the native text layer: native tokens are always kept and an OCR token whose center falls inside a native token is dropped. Pages without a region are never OCR'd. `PageDiagnostic.source` can now be `"mixed"`, and `PageDiagnostic.ocrRegionCount` reports the regions recognized. Profiles without regions keep whole-page OCR.
