---
"@familis/scribe-tesseract": patch
---

Stop writing a copy of the language data into the working directory. Without `cachePath`, the Tesseract adapter now turns the Tesseract.js cache off (`cacheMethod: "none"`) and reads `languageDataPath` directly; setting `cachePath` keeps the previous caching behaviour.
