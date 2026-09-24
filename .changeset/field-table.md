---
"@familis/scribe": minor
---

Add `field.table`, which extracts a table as rows of typed columns. The header is the first line where every column label matches, column boundaries sit halfway between label centers, a row starts at every line with a token in the `rowKey` column, and other lines join the vertically nearest row so cells wrapped above their row stay in it. Column transforms run per cell: a failing transform sets the cell to `null` with a `TRANSFORM_FAILED` diagnostic, and a row missing a required cell is dropped with `TABLE_ROW_DROPPED`. An optional `filter` removes rows, and evidence is emitted per cell (`/visits/3/date`).
