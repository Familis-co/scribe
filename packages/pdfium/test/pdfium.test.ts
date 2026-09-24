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
        minimalPdf("Contract", "100 400 m 100 700 l S"),
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

  it("maps malformed data to InvalidPdfError", async () => {
    const engine = await createPdfiumEngine();
    await expect(engine.open(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(InvalidPdfError);
    await engine.close();
  });
});
