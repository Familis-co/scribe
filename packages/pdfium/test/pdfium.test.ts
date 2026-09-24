import { describe, expect, it } from "vitest";
import { InvalidPdfError } from "@familis/scribe";
import { verifyPdfEngineContract } from "@familis/scribe/testing";
import { createPdfiumEngine } from "../src/index.js";
import { minimalPdf } from "./fixture.js";

describe("PDFium adapter", () => {
  it("satisfies the PDF engine contract with positioned native text", async () => {
    const engine = await createPdfiumEngine();
    const fixture = minimalPdf("Hello PDFium");
    const document = await engine.open(fixture);
    const page = await document.getPage(0);
    const tokens = await page.extractText();
    const bitmap = await page.render({ dpi: 144, grayscale: true });
    expect(tokens.map((token) => token.text).join(" ")).toContain("Hello PDFium");
    expect(bitmap).toMatchObject({ format: "gray8", dpi: 144 });
    await document.close();
    await engine.close();
  });

  it("passes the reusable PDF contract", async () => {
    await expect(
      verifyPdfEngineContract(
        await createPdfiumEngine(),
        minimalPdf("Contract", "100 400 m 100 700 l S\nq 120 0 0 30 100 650 cm /Im1 Do Q", {
          width: 4,
          height: 1,
          data: new Uint8Array([0, 85, 170, 255]),
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("reads stroked lines, stroked rectangles and thin filled boxes as rules", async () => {
    const engine = await createPdfiumEngine();
    const graphics = [
      "0.5 w 100 400 m 100 700 l S", // a vertical line
      "300 400 0.8 300 re f", // a thin filled box
      "400 450 100 50 re S", // a stroked rectangle, contributing its four sides
      "50 50 200 200 re f", // a filled box too wide to be a rule
      "72 100 m 75 100 l S", // a tick too short to be a rule
      "150 300 m 250 350 l S", // a slanted line
    ].join("\n");
    const document = await engine.open(minimalPdf("Rules", graphics));
    const page = await document.getPage(0);
    const rules = await page.rules!();

    expect(rules.vertical.map((rule) => rule.position * 612)).toEqual([
      expect.closeTo(100, 1),
      expect.closeTo(300.4, 1),
      expect.closeTo(400, 1),
      expect.closeTo(500, 1),
    ]);
    expect(rules.vertical[0]).toMatchObject({
      start: expect.closeTo(1 - 700 / 792, 3),
      end: expect.closeTo(1 - 400 / 792, 3),
    });
    expect(rules.horizontal.map((rule) => (1 - rule.position) * 792)).toEqual([
      expect.closeTo(500, 1),
      expect.closeTo(450, 1),
    ]);
    expect(rules.horizontal[0]).toMatchObject({
      start: expect.closeTo(400 / 612, 3),
      end: expect.closeTo(500 / 612, 3),
    });
    await document.close();
    await engine.close();
  });

  it("renders only a clipped area, matching the same pixels of a full render", async () => {
    const engine = await createPdfiumEngine();
    const document = await engine.open(minimalPdf("Clipped rendering"));
    const page = await document.getPage(0);
    const full = await page.render({ dpi: 144, grayscale: true });
    const clip = { x: 0.1, y: 0.05, width: 0.5, height: 0.1 };
    const clipped = await page.render({ dpi: 144, grayscale: true, clip });

    // 612 × 792 points at 144 DPI is 1224 × 1584 pixels; the clip widens to whole pixels.
    const [left, top, right, bottom] = [122, 79, 735, 238];
    expect(clipped).toMatchObject({
      width: right - left,
      height: bottom - top,
      dpi: 144,
      box: {
        x: left / 1224,
        y: top / 1584,
        width: (right - left) / 1224,
        height: (bottom - top) / 1584,
      },
    });
    expect(full).not.toHaveProperty("box");
    let different = 0;
    let ink = 0;
    for (let y = 0; y < clipped.height; y += 1) {
      for (let x = 0; x < clipped.width; x += 1) {
        const pixel = clipped.data[y * clipped.width + x]!;
        if (pixel < 128) ink += 1;
        if (Math.abs(pixel - full.data[(top + y) * full.width + left + x]!) > 8) different += 1;
      }
    }
    expect(ink).toBeGreaterThan(500);
    expect(different).toBe(0);
    await document.close();
    await engine.close();
  });

  it("returns upright embedded images at their native resolution", async () => {
    const engine = await createPdfiumEngine();
    const image = {
      width: 160,
      height: 40,
      data: Uint8Array.from({ length: 160 * 40 }, (_, index) => index % 160),
    };
    const graphics = [
      "q 120 0 0 30 100 650 cm /Im1 Do Q", // 160 pixels over 120 points: 96 DPI
      "q 120 0 0 -30 300 400 cm /Im1 Do Q", // flipped: left to the rendered fallback
    ].join("\n");
    const document = await engine.open(minimalPdf("Images", graphics, image));
    const page = await document.getPage(0);
    const images = await page.images!();

    expect(images).toHaveLength(1);
    expect(images[0]?.box).toEqual({
      x: expect.closeTo(100 / 612, 4),
      y: expect.closeTo(1 - 680 / 792, 4),
      width: expect.closeTo(120 / 612, 4),
      height: expect.closeTo(30 / 792, 4),
    });
    expect(images[0]?.bitmap).toMatchObject({ width: 160, height: 40, format: "gray8" });
    expect(images[0]?.bitmap.dpi).toBeCloseTo(96, 3);
    expect(images[0]?.bitmap.data).toEqual(image.data);
    await document.close();
    await engine.close();
  });

  it("maps malformed data to InvalidPdfError", async () => {
    const engine = await createPdfiumEngine();
    await expect(engine.open(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(InvalidPdfError);
    await engine.close();
  });
});
