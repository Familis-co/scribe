# @familis/scribe-pdfium

## 0.3.0

### Minor Changes

- e32cb6c: OCR embedded images at their native resolution, and render only the OCR region. `PdfPage` gains an optional `images()` method, implemented by the PDFium adapter, returning upright embedded images with their placement and native pixels. With `ocr.regions`, core recognizes the images overlapping each region, cropped to it, instead of a 300 DPI page render that resamples and smears their glyphs; tiny images such as logos are skipped. A region without an image is rendered on its own through the new `PdfRenderOptions.clip`, at the region's new `renderDpi` (300 by default), so `maxPixelsPerPage` applies to the clipped area. Adapters that ignore `clip` get the whole page rendered once per density and cropped. `PageBitmap.box` reports the area a clipped render covers, `PageDiagnostic.ocrImageCount` the images recognized, and `verifyPdfEngineContract` checks `images()` and clipped renders when present. Profiles without `ocr.regions` behave as before.
- 081a9d3: Make `field.table` robust on real documents. `rowTolerance` drops body lines farther than a fraction of the median row pitch from every row, such as a footer or a total line, with a `TABLE_LINES_DROPPED` diagnostic instead of merging them into the last row, and treats row starts much closer than the pitch as wrapped fragments. `fuzzy` matches OCR-damaged header labels, and `minColumns` (`"all"`, `"half"` or a count) accepts a header with missing labels, whose columns become `null` with a `TABLE_COLUMN_NOT_FOUND` warning. `PdfPage` gains an optional `rules()` method, implemented by the PDFium adapter from the page's vector paths: when the vertical rules crossing a table separate every header, they define the column spans, and a token crossing a rule is split when both sides keep at least 3 characters and a quarter of the token. Set `useRules: false` to keep label midpoints. `verifyPdfEngineContract` checks `rules()` when an adapter implements it.

### Patch Changes

- Updated dependencies [4e9cffc]
- Updated dependencies [2883c3a]
- Updated dependencies [e32cb6c]
- Updated dependencies [081a9d3]
- Updated dependencies [7d188c5]
  - @familis/scribe@0.3.0

## 0.2.1

### Patch Changes

- @familis/scribe@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [2abd0e4]
- Updated dependencies [93853d1]
- Updated dependencies [1e4e9bc]
- Updated dependencies [b9ed5f9]
- Updated dependencies [1ab5c61]
  - @familis/scribe@0.2.0
