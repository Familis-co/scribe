import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScribe,
  defineProfile,
  ExtractionError,
  field,
  select,
  transform,
  type TextToken,
} from "../src/index.js";
import { box, MockOcrEngine, MockPdfEngine, token } from "./helpers.js";

/** Rejects references that do not have exactly seven digits. */
const sevenDigits = transform.custom("sevenDigits", (value) => {
  const digits = String(value).replace(/\D/gu, "");
  if (digits.length !== 7) throw new TypeError(`Expected 7 digits, got ${digits.length}.`);
  return digits;
});

/**
 * Builds a reference profile that falls back from a label to a page-wide pattern.
 *
 * @param options - Wrapper options passed to `field.firstOf`
 * @returns The profile
 */
const referenceProfile = (options: Parameters<typeof field.firstOf>[1] = {}) =>
  defineProfile({
    id: "reference",
    version: "1",
    languages: ["fra"],
    schema: z.object({ reference: z.string().optional() }),
    fields: {
      reference: field.firstOf(
        [
          field.text({
            select: select.afterAnchor({ text: /Reference\s*:/iu }),
            transforms: [sevenDigits],
            required: true,
          }),
          field.text({
            select: select.region({ x: 0, y: 0, width: 1, height: 0.5 }, 1),
            pattern: /Ref\w*\s*[:.]?\s*(\d{7})/iu,
            group: 1,
            transforms: [sevenDigits],
          }),
        ],
        options,
      ),
    },
  });

/**
 * Parses native tokens with the reference profile.
 *
 * @param tokens - Tokens of the only page
 * @param options - Wrapper options passed to `field.firstOf`
 * @returns The extraction result
 */
const parse = (tokens: readonly TextToken[], options?: Parameters<typeof field.firstOf>[1]) =>
  createScribe({ pdf: new MockPdfEngine([tokens]) }).parse(
    new Uint8Array([1]),
    referenceProfile(options),
    { ocr: "never" },
  );

describe("field.firstOf", () => {
  it("uses the first alternative when it resolves", async () => {
    const result = await parse([
      token("Reference:", box(0.1, 0.1), 0),
      token("1234567", box(0.25, 0.1), 0),
    ]);

    expect(result.data.reference).toBe("1234567");
    expect(result.evidence["/reference"]?.[0]).toMatchObject({ alternative: 0, text: "1234567" });
    expect(result.diagnostics.some((item) => item.code === "FALLBACK_USED")).toBe(false);
  });

  it("falls back when the first alternative captures nothing", async () => {
    const result = await parse([
      token("Refcrence.", box(0.1, 0.1), 0),
      token("7654321", box(0.25, 0.1), 0),
    ]);

    expect(result.data.reference).toBe("7654321");
    expect(result.evidence["/reference"]?.[0]).toMatchObject({ alternative: 1, text: "7654321" });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: "info", code: "FALLBACK_USED", path: "/reference" }),
    );
  });

  it("falls back when the first alternative's transform rejects the reading", async () => {
    const result = await parse([
      token("Reference:", box(0.1, 0.1), 0),
      token("12345", box(0.25, 0.1), 0),
      token("Ref.", box(0.1, 0.3), 1),
      token("7654321", box(0.25, 0.3), 1),
    ]);

    expect(result.data.reference).toBe("7654321");
    expect(result.evidence["/reference"]?.[0]).toMatchObject({ alternative: 1 });
    const fallback = result.diagnostics.find((item) => item.code === "FALLBACK_USED");
    expect(fallback?.message).toContain("Expected 7 digits, got 5.");
    expect(result.diagnostics.some((item) => item.code === "TRANSFORM_FAILED")).toBe(false);
  });

  it("raises ExtractionError with the field's pointer when every alternative fails", async () => {
    const failure = parse([token("Reference:", box(0.1, 0.1), 0), token("12", box(0.25, 0.1), 0)]);

    await expect(failure).rejects.toBeInstanceOf(ExtractionError);
    await expect(failure).rejects.toMatchObject({ missingPaths: ["/reference"] });
  });

  it("retries with OCR in auto mode when every alternative rejects its native reading", async () => {
    const pdf = new MockPdfEngine([
      [
        token("Reference:", box(0.1, 0.1), 0),
        token("12345", box(0.25, 0.1), 0),
        token("Long enough native text", box(0.1, 0.6, 0.5), 1),
      ],
    ]);
    const ocr = new MockOcrEngine([
      {
        tokens: [
          token("Reference:", box(0.1, 0.1), 0, "ocr"),
          token("1234567", box(0.25, 0.1), 0, "ocr"),
        ],
      },
    ]);

    const result = await createScribe({ pdf, ocr }).parse(new Uint8Array([1]), referenceProfile());

    expect(ocr.recognizeCount).toBe(1);
    expect(result.data.reference).toBe("1234567");
  });

  it("ignores the alternatives' own required flag and applies the wrapper's options", async () => {
    const optional = await parse([], { required: false });
    expect(optional.data.reference).toBeUndefined();
    expect(optional.diagnostics).toContainEqual(
      expect.objectContaining({ level: "info", code: "FIELD_NOT_FOUND", path: "/reference" }),
    );

    const defaulted = await parse([], { defaultValue: "0000000" });
    expect(defaulted.data.reference).toBe("0000000");
  });

  it("warns about a low-confidence winning value with the wrapper's threshold", async () => {
    const result = await parse(
      [
        token("Reference:", box(0.1, 0.1), 0, "ocr", 0.99),
        token("1234567", box(0.25, 0.1), 0, "ocr", 0.5),
      ],
      { warnBelowConfidence: 0.8 },
    );

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LOW_FIELD_CONFIDENCE", path: "/reference" }),
    );
  });

  it("validates its configuration", () => {
    expect(() => field.firstOf([])).toThrow(TypeError);
    expect(() =>
      field.firstOf([field.text({ select: select.region(box(0, 0, 1, 1)) })], {
        warnBelowConfidence: 2,
      }),
    ).toThrow(RangeError);
  });
});
