---
"@familis/scribe-tesseract": patch
---

Stop leaking a worker thread on every parse when Tesseract language data is missing. With a local `languageDataPath`, the adapter now checks that each requested `<lang>.traineddata` (or `.traineddata.gz`) file is readable before starting a worker, and rejects with an `OcrError` naming the missing file and the configured path. A worker that still fails to initialize, for example on corrupt data, is no longer retried on every call: the engine remembers the failure per language set, so at most one start leaks. Create a new engine once the data is fixed.
