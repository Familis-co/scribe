---
"@familis/scribe": minor
"@familis/scribe-pdfium": minor
---

Make `field.table` robust on real documents. `rowTolerance` drops body lines farther than a fraction of the median row pitch from every row, such as a footer or a total line, with a `TABLE_LINES_DROPPED` diagnostic instead of merging them into the last row, and treats row starts much closer than the pitch as wrapped fragments. `fuzzy` matches OCR-damaged header labels, and `minColumns` (`"all"`, `"half"` or a count) accepts a header with missing labels, whose columns become `null` with a `TABLE_COLUMN_NOT_FOUND` warning. `PdfPage` gains an optional `rules()` method, implemented by the PDFium adapter from the page's vector paths: when the vertical rules crossing a table separate every header, they define the column spans, and a token crossing a rule is split when both sides keep at least 3 characters and a quarter of the token. Set `useRules: false` to keep label midpoints. `verifyPdfEngineContract` checks `rules()` when an adapter implements it.
