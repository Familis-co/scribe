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
  type PdfPageImage,
} from "../src/index.js";
import { box, MockOcrEngine, MockPdfEngine, token } from "./helpers.js";

/**
 * Builds a grayscale bitmap whose pixels hold their column index.
 *
 * @param width - Width in pixels
 * @param height - Height in pixels
 * @param dpi - Effective density
 * @returns The bitmap
 */
const columns = (width: number, height: number, dpi: number): PageBitmap => ({
  data: Uint8Array.from({ length: width * height }, (_, index) => index % width),
  width,
  height,
  format: "gray8",
  dpi,
});

/** A 96 DPI header band embedded as an image. */
const header: PdfPageImage = {
  box: { x: 0.1, y: 0.06, width: 0.8, height: 0.1 },
  bitmap: columns(160, 40, 96),
};

/** A logo too small to hold text worth recognizing. */
const logo: PdfPageImage = {
  box: { x: 0.06, y: 0.06, width: 0.03, height: 0.03 },
  bitmap: columns(32, 32, 96),
};

/** The header band declared as an OCR region. */
const band: OcrRegion = { page: 1, box: { x: 0.05, y: 0.05, width: 0.9, height: 0.16 } };

/**
 * Builds a profile returning all the text of page 1.
 *
 * @param regions - Declared OCR regions
 * @returns The profile
 */
const profileWith = (...regions: OcrRegion[]) =>
  defineProfile({
    id: "images",
    version: "1",
    languages: ["fra"],
    schema: z.object({ all: z.string().optional() }),
    fields: { all: field.text({ select: select.region(box(0, 0, 1, 1), 1), required: false }) },
    ocr: { regions },
  });

/** OCR output: one word filling the right half of whatever bitmap it is given. */
const word = {
  tokens: [token("Dossier", box(0.5, 0.5, 0.5, 0.5), 0, "ocr", 0.9)],
  confidence: 0.9,
};

describe("OCR of embedded images", () => {
  it("recognizes an embedded image at its native resolution instead of rendering", async () => {
    const pdf = new MockPdfEngine([[]], [], [], { images: [[header, logo]], clipping: true });
    const ocr = new MockOcrEngine([word]);

    const result = await createScribe({ pdf, ocr }).parse(new Uint8Array([1]), profileWith(band), {
      ocr: "always",
    });

    expect(pdf.document.pages[0]?.renderCount).toBe(0);
    expect(ocr.bitmaps).toEqual([header.bitmap]);
    expect(result.evidence["/all"]?.[0]?.box).toEqual({
      x: expect.closeTo(0.5),
      y: expect.closeTo(0.11),
      width: expect.closeTo(0.4),
      height: expect.closeTo(0.05),
    });
    expect(result.pages[0]).toMatchObject({ source: "ocr", ocrRegionCount: 1, ocrImageCount: 1 });
  });

  it("crops an image to the part inside the region", async () => {
    const pdf = new MockPdfEngine([[]], [], [], { images: [[header]] });
    const ocr = new MockOcrEngine([word]);
    const rightHalf: OcrRegion = { page: 1, box: { x: 0.5, y: 0, width: 0.5, height: 0.5 } };

    const result = await createScribe({ pdf, ocr }).parse(
      new Uint8Array([1]),
      profileWith(rightHalf),
      { ocr: "always" },
    );

    expect(ocr.bitmaps[0]).toMatchObject({ width: 80, height: 40, dpi: 96 });
    expect(ocr.bitmaps[0]?.data[0]).toBe(80);
    expect(result.evidence["/all"]?.[0]?.box.x).toBeCloseTo(0.7);
  });

  it("renders only the region, at its renderDpi, when no image covers it", async () => {
    const pdf = new MockPdfEngine([[]], [], [], { images: [[logo]], clipping: true });
    const ocr = new MockOcrEngine([
      { tokens: [token("Dossier", box(0, 0, 1, 1), 0, "ocr", 0.9)], confidence: 0.9 },
    ]);

    const result = await createScribe({ pdf, ocr }).parse(
      new Uint8Array([1]),
      profileWith({ ...band, renderDpi: 96 }),
      { ocr: "always" },
    );

    const page = pdf.document.pages[0];
    expect(page?.renders).toEqual([{ dpi: 96, grayscale: true, clip: band.box }]);
    // 612 × 792 points at 96 DPI is 816 × 1056 pixels; the band widens to whole pixels.
    expect(ocr.bitmaps[0]).toMatchObject({ width: 736, height: 170, dpi: 96 });
    expect(ocr.bitmaps[0]).not.toHaveProperty("box");
    expect(result.evidence["/all"]?.[0]?.box).toEqual({
      x: expect.closeTo(40 / 816),
      y: expect.closeTo(52 / 1056),
      width: expect.closeTo(736 / 816),
      height: expect.closeTo(170 / 1056),
    });
    expect(result.pages[0]).toMatchObject({ ocrRegionCount: 1, ocrImageCount: 0 });
  });

  it("checks maxPixelsPerPage against the clipped area", async () => {
    const region = { ...band, renderDpi: 96 };
    const fits = new MockPdfEngine([[]], [], [], { clipping: true });
    await createScribe({
      pdf: fits,
      ocr: new MockOcrEngine([word]),
      limits: { maxPixelsPerPage: 200_000 },
    }).parse(new Uint8Array([1]), profileWith(region), { ocr: "always" });
    expect(fits.document.pages[0]?.renderCount).toBe(1);

    const tooLarge = new MockPdfEngine([[]], [], [], { clipping: true });
    await expect(
      createScribe({
        pdf: tooLarge,
        ocr: new MockOcrEngine([]),
        limits: { maxPixelsPerPage: 100_000 },
      }).parse(new Uint8Array([1]), profileWith(region), { ocr: "always" }),
    ).rejects.toBeInstanceOf(LimitExceededError);
    expect(tooLarge.document.pages[0]?.renderCount).toBe(0);
  });

  it("renders the page once for every region when the adapter ignores clip", async () => {
    const pdf = new MockPdfEngine([[]], [columns(100, 100, 300)]);
    const ocr = new MockOcrEngine([word, word]);
    const left: OcrRegion = { page: 1, box: { x: 0, y: 0, width: 0.5, height: 0.5 } };
    const right: OcrRegion = { page: 1, box: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } };

    const result = await createScribe({ pdf, ocr }).parse(
      new Uint8Array([1]),
      profileWith(left, right),
      { ocr: "always" },
    );

    expect(pdf.document.pages[0]?.renderCount).toBe(1);
    expect(ocr.bitmaps.map((bitmap) => [bitmap.width, bitmap.data[0]])).toEqual([
      [50, 0],
      [50, 50],
    ]);
    expect(result.pages[0]).toMatchObject({ ocrRegionCount: 2, ocrImageCount: 0 });
  });

  it("validates renderDpi", () => {
    for (const renderDpi of [0, -96, Number.NaN]) {
      expect(() => profileWith({ ...band, renderDpi })).toThrow(RangeError);
    }
  });
});
