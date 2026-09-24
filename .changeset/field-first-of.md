---
"@familis/scribe": minor
---

Add `field.firstOf`, an ordered fallback between extraction strategies. Alternatives are tried in order and the first one that captures a value whose transforms all succeed wins; a throwing transform rejects a reading and moves on to the next alternative. `required`, `defaultValue` and `warnBelowConfidence` live on the wrapper. Evidence carries the winning `alternative` index, and an info diagnostic `FALLBACK_USED` is emitted when it is not the first.
