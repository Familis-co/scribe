/**
 * Reusable contract checks for custom PDF and OCR adapters.
 *
 * @packageDocumentation
 */
import type { OcrEngine, PageBitmap, PdfEngine } from "./types.js";

/**
 * Runs reusable behavioral checks against a PDF adapter.
 *
 * @remarks
 * The helper opens the fixture, validates page metadata, normalized native token boxes, a grayscale
 * render, and a clipped render when the adapter honors `clip`. When the adapter implements them, it
 * also validates page rules and embedded images. It then closes both the document and engine.
 *
 * @param engine - Adapter instance under test
 * @param fixture - Valid PDF bytes containing at least one page
 * @returns A promise that resolves when the contract is satisfied
 * @throws `Error` when the adapter violates the public contract
 */
export async function verifyPdfEngineContract(
  engine: PdfEngine,
  fixture: Uint8Array,
): Promise<void> {
  const document = await engine.open(fixture);
  try {
    if (!Number.isInteger(document.pageCount) || document.pageCount < 1) {
      throw new Error("PdfDocument.pageCount must be a positive integer.");
    }
    const page = await document.getPage(0);
    if (page.number !== 1 || page.index !== 0 || page.width <= 0 || page.height <= 0) {
      throw new Error("The first PDF page exposes invalid metadata.");
    }
    for (const token of await page.extractText()) {
      const { x, y, width, height } = token.box;
      if ([x, y, width, height].some((value) => value < 0 || value > 1)) {
        throw new Error("PDF text boxes must use normalized coordinates.");
      }
    }
    const bitmap = await page.render({ dpi: 72, grayscale: true });
    if (bitmap.format !== "gray8" || bitmap.data.length !== bitmap.width * bitmap.height) {
      throw new Error("A grayscale PDF render must contain exactly one byte per pixel.");
    }
    const clip = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    const clipped = await page.render({ dpi: 72, grayscale: true, clip });
    if (clipped.box) {
      const { x, y, width, height } = clipped.box;
      const epsilon = 1e-6;
      if (
        x > clip.x + epsilon ||
        y > clip.y + epsilon ||
        x + width < clip.x + clip.width - epsilon ||
        y + height < clip.y + clip.height - epsilon ||
        Math.round(width * bitmap.width) !== clipped.width ||
        Math.round(height * bitmap.height) !== clipped.height
      ) {
        throw new Error("A clipped render must cover the clip in whole pixels of the full render.");
      }
    }
    if (page.images) {
      for (const image of await page.images()) {
        const { x, y, width, height } = image.box;
        if ([x, y, width, height].some((value) => value < 0 || value > 1)) {
          throw new Error("Embedded image boxes must use normalized coordinates.");
        }
        const channels = image.bitmap.format === "gray8" ? 1 : 4;
        if (image.bitmap.data.length !== image.bitmap.width * image.bitmap.height * channels) {
          throw new Error("An embedded image bitmap must match its size and format.");
        }
        if (image.bitmap.dpi !== undefined && !(image.bitmap.dpi > 0)) {
          throw new Error("An embedded image's effective DPI must be positive.");
        }
      }
    }
    if (page.rules) {
      const rules = await page.rules();
      for (const rule of [...rules.vertical, ...rules.horizontal]) {
        const { position, start, end } = rule;
        if ([position, start, end].some((value) => !(value >= 0 && value <= 1)) || start > end) {
          throw new Error("Page rules must use normalized coordinates with start before end.");
        }
      }
      for (const list of [rules.vertical, rules.horizontal]) {
        if (list.some((rule, index) => index > 0 && rule.position < list[index - 1]!.position)) {
          throw new Error("Page rules must be sorted by position.");
        }
      }
    }
  } finally {
    await document.close();
    await engine.close();
  }
}

/**
 * Runs reusable behavioral checks against an OCR adapter.
 *
 * @param engine - Adapter instance under test
 * @param bitmap - Representative bitmap fixture
 * @param languages - Explicit languages available to the test engine
 * @returns A promise that resolves when the contract is satisfied
 * @throws `Error` when tokens use an invalid source or coordinate range
 */
export async function verifyOcrEngineContract(
  engine: OcrEngine,
  bitmap: PageBitmap,
  languages: readonly string[],
): Promise<void> {
  const result = await engine.recognize(bitmap, { languages });
  for (const token of result.tokens) {
    if (token.source !== "ocr") throw new Error("OCR tokens must declare the ocr source.");
    const { x, y, width, height } = token.box;
    if ([x, y, width, height].some((value) => value < 0 || value > 1)) {
      throw new Error("OCR text boxes must use normalized coordinates.");
    }
  }
  await engine.close();
  await engine.close();
}
