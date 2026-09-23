import { readFile } from "node:fs/promises";
import { createScribe, defineProfile, field, select, transform } from "@familis/scribe";
import { createPdfiumEngine } from "@familis/scribe-pdfium";
import { createTesseractEngine } from "@familis/scribe-tesseract";
import { z } from "zod";

const invoiceProfile = defineProfile({
  id: "familis-invoice",
  version: "1",
  languages: ["fra"],
  schema: z.object({
    number: z.string(),
    issuedAt: z.iso.date(),
    total: z.number().nonnegative(),
  }),
  fields: {
    number: field.text({
      select: select.relativeToAnchor({
        text: /facture\s*(?:n°|no)?/iu,
        offset: { x: 0.18, y: -0.01, width: 0.3, height: 0.06 },
      }),
      transforms: [transform.normalizeWhitespace()],
    }),
    issuedAt: field.text({
      select: select.relativeToAnchor({
        text: "Date",
        offset: { x: 0.12, y: -0.01, width: 0.25, height: 0.06 },
      }),
      pattern: /(\d{2}\/\d{2}\/\d{4})/u,
      group: 1,
      transforms: [transform.date("DD/MM/YYYY")],
    }),
    total: field.text({
      select: select.relativeToAnchor({
        text: /total\s+ttc/iu,
        offset: { x: 0.2, y: -0.01, width: 0.3, height: 0.06 },
      }),
      pattern: /([\d\s]+,\d{2})/u,
      group: 1,
      transforms: [transform.number({ decimalSeparator: ",", groupSeparators: [" ", "\u00a0"] })],
    }),
  },
});

const pdfPath = process.argv[2];
const languageDataPath = process.env.TESSDATA_PATH;
if (!pdfPath || !languageDataPath) {
  throw new Error("Usage: TESSDATA_PATH=/path/to/tessdata node dist/index.js invoice.pdf");
}

const scribe = createScribe({
  pdf: await createPdfiumEngine(),
  ocr: await createTesseractEngine({ languageDataPath }),
});

try {
  const result = await scribe.parse(await readFile(pdfPath), invoiceProfile, { ocr: "auto" });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await scribe.close();
}
