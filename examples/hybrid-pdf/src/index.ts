import { readFile } from "node:fs/promises";
import { createScribe, defineProfile, field, select } from "@familis/scribe";
import { createPdfiumEngine } from "@familis/scribe-pdfium";
import { createTesseractEngine } from "@familis/scribe-tesseract";
import { z } from "zod";

const profile = defineProfile({
  id: "hybrid-reference",
  version: "1",
  languages: ["fra", "eng"],
  schema: z.object({ reference: z.string() }),
  fields: {
    reference: field.text({
      select: select.relativeToAnchor({
        text: /référence|reference/iu,
        offset: { x: 0.18, y: -0.01, width: 0.35, height: 0.07 },
      }),
    }),
  },
});

const pdfPath = process.argv[2];
const languageDataPath = process.env.TESSDATA_PATH;
if (!pdfPath || !languageDataPath) {
  throw new Error("Usage: TESSDATA_PATH=/path/to/tessdata node dist/index.js document.pdf");
}

const scribe = createScribe({
  pdf: await createPdfiumEngine(),
  ocr: await createTesseractEngine({ languageDataPath }),
});

try {
  const result = await scribe.parse(await readFile(pdfPath), profile, { ocr: "auto" });
  console.log(JSON.stringify({ data: result.data, pages: result.pages }, null, 2));
} finally {
  await scribe.close();
}
