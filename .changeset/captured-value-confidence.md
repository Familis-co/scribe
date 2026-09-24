---
"@familis/scribe": minor
---

Field confidence now comes from the captured value, not the whole selected region. With a `pattern`, only the tokens overlapping the captured group drive the value's `confidence`, the evidence `box` and the evidence `text`, so a misread value inside a well-read sentence now triggers `LOW_FIELD_CONFIDENCE`. Confidence is the lowest token confidence instead of the mean. `field.list` reports one evidence entry and one confidence per value, and its low-confidence diagnostics point at the item (`/codes/1`). Fields without a `pattern` still use every selected token.
