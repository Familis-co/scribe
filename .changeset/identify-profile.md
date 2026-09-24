---
"@familis/scribe": minor
---

Identify the document type before OCR. Profiles accept `identify: { text, caseSensitive, test }`: every `text` literal or pattern must be found in the native text layer, then the optional `test` predicate must pass. `scribe.parse` checks it right after native text extraction and throws the new `ProfileMismatchError` (`PROFILE_MISMATCH`) before any page is rendered or OCR'd. The new `scribe.identify(bytes, profiles)` returns the single candidate whose rules match, throwing `ProfileMismatchError` when none does and the new `AmbiguousProfileError` (`AMBIGUOUS_PROFILE`) when several do. Profiles without `identify` behave as before.
