---
"@familis/scribe": minor
"@familis/scribe-pdfium": minor
---

OCR embedded images at their native resolution, and render only the OCR region. `PdfPage` gains an optional `images()` method, implemented by the PDFium adapter, returning upright embedded images with their placement and native pixels. With `ocr.regions`, core recognizes the images overlapping each region, cropped to it, instead of a 300 DPI page render that resamples and smears their glyphs; tiny images such as logos are skipped. A region without an image is rendered on its own through the new `PdfRenderOptions.clip`, at the region's new `renderDpi` (300 by default), so `maxPixelsPerPage` applies to the clipped area. Adapters that ignore `clip` get the whole page rendered once per density and cropped. `PageBitmap.box` reports the area a clipped render covers, `PageDiagnostic.ocrImageCount` the images recognized, and `verifyPdfEngineContract` checks `images()` and clipped renders when present. Profiles without `ocr.regions` behave as before.
