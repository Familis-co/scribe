import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createScribe, DisposedError, field, select, defineProfile } from "../src/index.js";
import { box, MockOcrEngine, MockPdfEngine, token } from "./helpers.js";

const profile = defineProfile({
  id: "reference",
  version: "1",
  languages: ["eng"],
  schema: z.object({ reference: z.string() }),
  fields: {
    reference: field.text({
      select: select.relativeToAnchor({
        text: "Reference",
        offset: box(0.25, -0.01, 0.3, 0.07),
      }),
    }),
  },
});

describe("Scribe pipeline", () => {
  it("uses OCR only when a required native field is unresolved", async () => {
    const pdf = new MockPdfEngine([[token("Reference", box(0.1, 0.1, 0.12))]]);
    const ocr = new MockOcrEngine([
      {
        tokens: [
          token("Reference", box(0.1, 0.1, 0.12), 0, "ocr"),
          token("ABC-42", box(0.36, 0.1, 0.15), 0, "ocr"),
        ],
        confidence: 0.92,
      },
    ]);
    const scribe = createScribe({ pdf, ocr });

    const result = await scribe.parse(new Uint8Array([1]), profile);

    expect(result.data.reference).toBe("ABC-42");
    expect(ocr.recognizeCount).toBe(1);
    expect(result.pages[0]).toMatchObject({ source: "ocr", ocrConfidence: 0.92 });
    expect(result.diagnostics.some((item) => item.code === "OCR_FALLBACK_USED")).toBe(true);
  });

  it("does not invoke OCR when native extraction succeeds", async () => {
    const pdf = new MockPdfEngine([
      [token("Reference", box(0.1, 0.1, 0.12)), token("ABC-42-LONG-ENOUGH", box(0.36, 0.1, 0.24))],
    ]);
    const ocr = new MockOcrEngine([]);
    const result = await createScribe({ pdf, ocr }).parse(new Uint8Array([1]), profile);

    expect(result.data.reference).toBe("ABC-42-LONG-ENOUGH");
    expect(ocr.recognizeCount).toBe(0);
  });

  it("renders but does not send blank pages to the OCR engine", async () => {
    const whiteBitmap = {
      data: new Uint8Array(100).fill(255),
      width: 10,
      height: 10,
      format: "gray8",
      dpi: 300,
    } as const;
    const pdf = new MockPdfEngine(
      [
        [
          token("Reference", box(0.1, 0.1, 0.12)),
          token("ABC-42-LONG-ENOUGH", box(0.36, 0.1, 0.24)),
        ],
        [],
      ],
      [undefined, whiteBitmap],
    );
    const ocr = new MockOcrEngine([]);

    const result = await createScribe({ pdf, ocr }).parse(new Uint8Array([1]), profile);

    expect(result.data.reference).toBe("ABC-42-LONG-ENOUGH");
    expect(ocr.recognizeCount).toBe(0);
    expect(result.pages[1]).toMatchObject({
      page: 2,
      source: "native",
      ocrSkippedReason: "blank-page",
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "OCR_SKIPPED_BLANK_PAGE", page: 2 }),
    );
  });

  it("honors never mode and reports missing required fields", async () => {
    const pdf = new MockPdfEngine([[token("Reference", box(0.1, 0.1))]]);
    const ocr = new MockOcrEngine([]);
    await expect(
      createScribe({ pdf, ocr }).parse(new Uint8Array([1]), profile, { ocr: "never" }),
    ).rejects.toMatchObject({
      code: "EXTRACTION_ERROR",
      missingPaths: ["/reference"],
    });
    expect(ocr.recognizeCount).toBe(0);
  });

  it("enforces byte limits before opening a document", async () => {
    const pdf = new MockPdfEngine([[]]);
    const scribe = createScribe({ pdf, limits: { maxBytes: 1 } });
    await expect(scribe.parse(new Uint8Array([1, 2]), profile)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      limit: "bytes",
    });
  });

  it("closes engines idempotently and rejects later parses", async () => {
    const pdf = new MockPdfEngine([[]]);
    const ocr = new MockOcrEngine([]);
    const scribe = createScribe({ pdf, ocr });
    await Promise.all([scribe.close(), scribe.close()]);
    expect(pdf.closeCount).toBe(1);
    expect(ocr.closeCount).toBe(1);
    await expect(scribe.parse(new Uint8Array([1]), profile)).rejects.toBeInstanceOf(DisposedError);
  });
});
