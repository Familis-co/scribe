# @familis/scribe

## 0.2.1

No changes in this release.

## 0.2.0

### Minor Changes

- 2abd0e4: Add `select.afterAnchor`, a line-scoped selector for values printed after a label. It selects the tokens on the anchor's visual line to the right of the anchor, optionally stopping before a `stopAt` match such as the next label, so it never catches the next line or a neighbouring label the way a fixed `relativeToAnchor` box can.
- 93853d1: Field confidence now comes from the captured value, not the whole selected region. With a `pattern`, only the tokens overlapping the captured group drive the value's `confidence`, the evidence `box` and the evidence `text`, so a misread value inside a well-read sentence now triggers `LOW_FIELD_CONFIDENCE`. Confidence is the lowest token confidence instead of the mean. `field.list` reports one evidence entry and one confidence per value, and its low-confidence diagnostics point at the item (`/codes/1`). Fields without a `pattern` still use every selected token.
- 1e4e9bc: Add `field.firstOf`, an ordered fallback between extraction strategies. Alternatives are tried in order and the first one that captures a value whose transforms all succeed wins; a throwing transform rejects a reading and moves on to the next alternative. `required`, `defaultValue` and `warnBelowConfidence` live on the wrapper. Evidence carries the winning `alternative` index, and an info diagnostic `FALLBACK_USED` is emitted when it is not the first.
- b9ed5f9: Add `field.table`, which extracts a table as rows of typed columns. The header is the first line where every column label matches, column boundaries sit halfway between label centers, a row starts at every line with a token in the `rowKey` column, and other lines join the vertically nearest row so cells wrapped above their row stay in it. Column transforms run per cell: a failing transform sets the cell to `null` with a `TRANSFORM_FAILED` diagnostic, and a row missing a required cell is dropped with `TABLE_ROW_DROPPED`. An optional `filter` removes rows, and evidence is emitted per cell (`/visits/3/date`).
- 1ab5c61: Profiles can declare `ocr.regions`, the only page areas ever sent to the OCR engine. Each page is rendered once, every region is cropped out of the render, and the recognized tokens are mapped back to page coordinates and merged with the native text layer: native tokens are always kept and an OCR token whose center falls inside a native token is dropped. Pages without a region are never OCR'd. `PageDiagnostic.source` can now be `"mixed"`, and `PageDiagnostic.ocrRegionCount` reports the regions recognized. Profiles without regions keep whole-page OCR.
