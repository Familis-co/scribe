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
      verifyPdfEngineContract(await createPdfiumEngine(), minimalPdf("Contract")),
    ).resolves.toBeUndefined();
  });

  it("maps malformed data to InvalidPdfError", async () => {
    const engine = await createPdfiumEngine();
    await expect(engine.open(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(InvalidPdfError);
    await engine.close();
  });
});
