---
"@familis/scribe": minor
---

Add `select.afterAnchor`, a line-scoped selector for values printed after a label. It selects the tokens on the anchor's visual line to the right of the anchor, optionally stopping before a `stopAt` match such as the next label, so it never catches the next line or a neighbouring label the way a fixed `relativeToAnchor` box can.
