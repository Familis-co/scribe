import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScribe,
  defineProfile,
  field,
  LimitExceededError,
  select,
  type OcrRegion,
  type PageBitmap,
} from "../src/index.js";
import { box, MockOcrEngine, MockPdfEngine, token } from "./helpers.js";

/** A 100×200 grayscale render whose pixels hold their row index, with blank rows from 180. */
const gradient: PageBitmap = {
  data: Uint8Array.from({ length: 100 * 200 }, (_, index) => {
    const row = Math.floor(index / 100);
    return row >= 180 ? 255 : row;
  }),
  width: 100,
  height: 200,
  format: "gray8",
  dpi: 300,
};

/** The header band OCR'd on page 1. */
const header: OcrRegion = { page: 1, box: { x: 0.1, y: 0.2, width: 0.5, height: 0.25 } };

/**
 * Builds a profile reading a reference after its label, plus the whole page text.
 *
 * @param regions - Declared OCR regions, or `undefined` for whole-page OCR
 * @returns The profile
 */
const profileWith = (regions?: readonly OcrRegion[]) =>
  defineProfile({
    id: "hybrid",
    version: "1",
    languages: ["fra"],
    schema: z.object({ reference: z.string(), all: z.string().optional() }),
    fields: {
      reference: field.text({ select: select.afterAnchor({ text: "Reference" }) }),
      all: field.text({ select: select.region(box(0, 0, 1, 1), 1), required: false }),
    },
    ...(regions ? { ocr: { regions } } : {}),
  });

/** Native table rows below the header, plus a native label inside the header band. */
const nativeLayer = [
  token("Date", box(0.1, 0.3, 0.1, 0.03), 0),
  token("Lundi", box(0.1, 0.6, 0.1, 0.03), 1),
  token("08:00", box(0.3, 0.6, 0.1, 0.03), 1),
];

describe("declared OCR regions", () => {
  it("merges region OCR with native text, remapping boxes and dropping overlapping OCR", async () => {
    const pdf = new MockPdfEngine([nativeLayer], [gradient]);
    const ocr = new MockOcrEngine([
      {
        tokens: [
          token("Reference", box(0, 0.1, 0.3, 0.1), 0, "ocr", 0.9),
          token("ABC-42", box(0.4, 0.1, 0.3, 0.1), 0, "ocr", 0.8),
          token("Dale", box(0, 0.4, 0.2, 0.12), 1, "ocr", 0.4),
        ],
        confidence: 0.85,
      },
    ]);

    const result = await createScribe({ pdf, ocr }).parse(
      new Uint8Array([1]),
      profileWith([header]),
    );

    expect(result.data).toEqual({
      reference: "ABC-42",
      all: "Reference ABC-42\nDate\nLundi 08:00",
    });
    expect(result.evidence["/reference"]?.[0]).toMatchObject({
      method: "ocr",
      box: {
        x: expect.closeTo(0.3),
        y: expect.closeTo(0.225),
        width: expect.closeTo(0.15),
        height: expect.closeTo(0.025),
      },
    });
    expect(result.pages[0]).toMatchObject({
      source: "mixed",
      ocrRegionCount: 1,
      ocrConfidence: 0.85,
      tokenCount: 5,
      nativeCharacterCount: 13,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "OCR_FALLBACK_USED" }),
    );

    const [crop] = ocr.bitmaps;
    expect(crop).toMatchObject({ width: 50, height: 50, format: "gray8", dpi: 300 });
    expect(crop?.data[0]).toBe(40);
    expect(crop?.data[49 * 50 + 49]).toBe(89);
  });

  it("crops RGBA renders", async () => {
    const rgba: PageBitmap = {
      data: Uint8Array.from({ length: 10 * 10 * 4 }, (_, index) =>
        index % 4 === 3 ? 255 : Math.floor(index / 4),
      ),
      width: 10,
      height: 10,
      format: "rgba8",
    };
    const pdf = new MockPdfEngine([[]], [rgba]);
    const ocr = new MockOcrEngine([{ tokens: [] }]);
    const profile = profileWith([{ page: 1, box: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } }]);

    await expect(
      createScribe({ pdf, ocr }).parse(new Uint8Array([1]), profile, { ocr: "always" }),
    ).rejects.toMatchObject({ code: "EXTRACTION_ERROR" });

    const crop = ocr.bitmaps[0];
    expect(crop).toMatchObject({ width: 5, height: 5, format: "rgba8" });
    expect(crop?.data.length).toBe(5 * 5 * 4);
    expect([...(crop?.data.subarray(0, 4) ?? [])]).toEqual([55, 55, 55, 255]);
    expect([...(crop?.data.subarray(-4) ?? [])]).toEqual([99, 99, 99, 255]);
  });

  it("never renders a page without a declared region, even with little native text", async () => {
    const resolved = [
      token("Reference", box(0.1, 0.1), 0),
      token("ABC-42-LONG-ENOUGH", box(0.3, 0.1, 0.3), 0),
    ];
    const boilerplate = [token("p. 2", box(0.1, 0.9), 0)];

    const auto = new MockPdfEngine([resolved, boilerplate]);
    const autoOcr = new MockOcrEngine([]);
    await createScribe({ pdf: auto, ocr: autoOcr }).parse(
      new Uint8Array([1]),
      profileWith([header]),
    );
    expect(auto.document.pages.map((page) => page.renderCount)).toEqual([0, 0]);
    expect(autoOcr.recognizeCount).toBe(0);

    const always = new MockPdfEngine([resolved, boilerplate]);
    const alwaysOcr = new MockOcrEngine([{ tokens: [] }]);
    const result = await createScribe({ pdf: always, ocr: alwaysOcr }).parse(
      new Uint8Array([1]),
      profileWith([header]),
      { ocr: "always" },
    );
    expect(always.document.pages.map((page) => page.renderCount)).toEqual([1, 0]);
    expect(result.data.reference).toBe("ABC-42-LONG-ENOUGH");
    expect(result.pages.map((page) => page.source)).toEqual(["native", "native"]);
    expect(result.pages[0]?.ocrRegionCount).toBe(1);
  });

  it("OCRs a region page that has too little native text in auto mode", async () => {
    const pdf = new MockPdfEngine([[]], [gradient]);
    const ocr = new MockOcrEngine([
      {
        tokens: [
          token("Reference", box(0, 0.1, 0.3, 0.1), 0, "ocr"),
          token("XYZ", box(0.4, 0.1, 0.3, 0.1), 0, "ocr"),
        ],
      },
    ]);

    const result = await createScribe({ pdf, ocr }).parse(
      new Uint8Array([1]),
      profileWith([header]),
    );

    expect(result.data.reference).toBe("XYZ");
    expect(result.pages[0]).toMatchObject({ source: "ocr", ocrRegionCount: 1 });
  });

  it("does not send blank regions to the OCR engine", async () => {
    const pdf = new MockPdfEngine([[]], [gradient]);
    const ocr = new MockOcrEngine([]);
    const blankBand: OcrRegion = { page: "any", box: { x: 0, y: 0.9, width: 1, height: 0.1 } };

    await expect(
      createScribe({ pdf, ocr }).parse(new Uint8Array([1]), profileWith([blankBand])),
    ).rejects.toMatchObject({ code: "EXTRACTION_ERROR" });
    expect(pdf.document.pages[0]?.renderCount).toBe(1);
    expect(ocr.recognizeCount).toBe(0);
  });

  it("still enforces maxPixelsPerPage", async () => {
    const pdf = new MockPdfEngine([[]]);
    const ocr = new MockOcrEngine([]);
    const scribe = createScribe({ pdf, ocr, limits: { maxPixelsPerPage: 1_000 } });

    await expect(scribe.parse(new Uint8Array([1]), profileWith([header]))).rejects.toBeInstanceOf(
      LimitExceededError,
    );
    expect(pdf.document.pages[0]?.renderCount).toBe(0);
  });

  it("keeps whole-page OCR for profiles without regions", async () => {
    const pdf = new MockPdfEngine([nativeLayer]);
    const ocr = new MockOcrEngine([
      {
        tokens: [
          token("Reference", box(0.1, 0.1), 0, "ocr"),
          token("ABC-42", box(0.3, 0.1), 0, "ocr"),
        ],
        confidence: 0.9,
      },
    ]);

    const result = await createScribe({ pdf, ocr }).parse(new Uint8Array([1]), profileWith());

    expect(result.data).toEqual({ reference: "ABC-42", all: "Reference ABC-42" });
    expect(ocr.bitmaps[0]).toMatchObject({ width: 10, height: 10 });
    expect(result.pages[0]).toMatchObject({ source: "ocr", tokenCount: 2 });
    expect(result.pages[0]).not.toHaveProperty("ocrRegionCount");
  });

  it("validates declared regions", () => {
    expect(() => profileWith([])).toThrow(TypeError);
    expect(() => profileWith([{ page: 0, box: box(0, 0, 1, 1) }])).toThrow(RangeError);
    expect(() => profileWith([{ page: 1, box: box(0.5, 0, 0.6, 1) }])).toThrow(RangeError);
    expect(() => profileWith([{ page: 1, box: box(0, 0, 0, 1) }])).toThrow(RangeError);
    expect(() => profileWith([{ page: "last", box: box(0.04, 0.22, 0.96, 0.78) }])).not.toThrow();
  });
});
