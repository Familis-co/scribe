---
"@familis/scribe": minor
---

Add fuzzy anchor matching and `select.belowAnchor`. `relativeToAnchor`, `afterAnchor` and the new `belowAnchor` accept `fuzzy`, a minimum similarity between `0` and `1`: a literal label then matches the closest run of 1 to 5 tokens on a line, compared without case, diacritics, punctuation or whitespace, so an OCR-damaged `Cossier N°:` still finds `Dossier N°:`. `afterAnchor`'s `stopAt` is fuzzy too, `RegExp` anchors stay exact, and the matched label and its score are recorded in evidence as `anchor`. `belowAnchor` selects the line under a label, within the label's column, for layouts that print the value below its label; `maxLines` and `maxDistance` bound the selection. Without `fuzzy`, anchors behave exactly as before.
