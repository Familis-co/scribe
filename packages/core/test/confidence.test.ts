import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createScribe, defineProfile, field, select } from "../src/index.js";
import { box, MockPdfEngine, token } from "./helpers.js";

/** A well-read covering sentence with one poorly read date at the end. */
const sentence = [
  token("pour", box(0.1, 0.3), 0, "ocr", 0.96),
  token("la", box(0.2, 0.3), 0, "ocr", 0.95),
  token("période", box(0.3, 0.3), 0, "ocr", 0.94),
  token("au", box(0.4, 0.3), 0, "ocr", 0.95),
  token("20/08/2026", box(0.5, 0.3), 0, "ocr", 0.3),
];

describe("captured value confidence", () => {
  it("scores a captured value by its own tokens, not the whole region", async () => {
    const profile = defineProfile({
      id: "period",
      version: "1",
      languages: ["fra"],
      schema: z.object({ end: z.string() }),
      fields: {
        end: field.text({
          select: select.region({ x: 0, y: 0.25, width: 1, height: 0.1 }, 1),
          pattern: /\bau\s+(\S+)/u,
          group: 1,
          warnBelowConfidence: 0.8,
        }),
      },
    });

    const result = await createScribe({ pdf: new MockPdfEngine([sentence]) }).parse(
      new Uint8Array([1]),
      profile,
      { ocr: "never" },
    );

    expect(result.data.end).toBe("20/08/2026");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LOW_FIELD_CONFIDENCE", path: "/end" }),
    );
    expect(result.evidence["/end"]).toEqual([
      {
        page: 1,
        box: { x: 0.5, y: 0.3, width: expect.closeTo(0.1), height: expect.closeTo(0.03) },
        text: "20/08/2026",
        method: "ocr",
        confidence: 0.3,
        transformations: [],
      },
    ]);
  });

  it("uses the lowest confidence of a value spanning several tokens", async () => {
    const profile = defineProfile({
      id: "named-group",
      version: "1",
      languages: ["fra"],
      schema: z.object({ range: z.string() }),
      fields: {
        range: field.text({
          select: select.region({ x: 0, y: 0.25, width: 1, height: 0.1 }, 1),
          pattern: /(?<range>période au)/u,
          group: "range",
        }),
      },
    });

    const result = await createScribe({ pdf: new MockPdfEngine([sentence]) }).parse(
      new Uint8Array([1]),
      profile,
      { ocr: "never" },
    );

    expect(result.evidence["/range"]?.[0]).toMatchObject({
      text: "période au",
      confidence: 0.94,
      box: { x: 0.3, y: 0.3, width: expect.closeTo(0.2), height: expect.closeTo(0.03) },
    });
  });

  it("reports a separate confidence and box for every list value", async () => {
    const pdf = new MockPdfEngine([
      [
        token("A-1", box(0.1, 0.1), 0, "ocr", 0.99),
        token("A-2", box(0.3, 0.1), 0, "ocr", 0.4),
        token("A-3", box(0.5, 0.1), 0, "ocr", 0.97),
      ],
    ]);
    const profile = defineProfile({
      id: "codes",
      version: "1",
      languages: ["eng"],
      schema: z.object({ codes: z.array(z.string()) }),
      fields: {
        codes: field.list({
          select: select.region({ x: 0, y: 0, width: 1, height: 0.2 }, 1),
          pattern: /A-\d/gu,
          warnBelowConfidence: 0.8,
        }),
      },
    });

    const result = await createScribe({ pdf }).parse(new Uint8Array([1]), profile, {
      ocr: "never",
    });

    expect(result.data.codes).toEqual(["A-1", "A-2", "A-3"]);
    expect(
      result.evidence["/codes"]?.map((item) => [item.text, item.confidence, item.box.x]),
    ).toEqual([
      ["A-1", 0.99, 0.1],
      ["A-2", 0.4, 0.3],
      ["A-3", 0.97, 0.5],
    ]);
    const warnings = result.diagnostics.filter((item) => item.code === "LOW_FIELD_CONFIDENCE");
    expect(warnings.map((item) => item.path)).toEqual(["/codes/1"]);
  });

  it("uses every selected token for fields without a pattern", async () => {
    const profile = defineProfile({
      id: "whole-region",
      version: "1",
      languages: ["fra"],
      schema: z.object({ text: z.string() }),
      fields: {
        text: field.text({ select: select.region({ x: 0, y: 0.25, width: 1, height: 0.1 }, 1) }),
      },
    });

    const result = await createScribe({ pdf: new MockPdfEngine([sentence]) }).parse(
      new Uint8Array([1]),
      profile,
      { ocr: "never" },
    );

    expect(result.data.text).toBe("pour la période au 20/08/2026");
    expect(result.evidence["/text"]?.[0]).toMatchObject({
      text: "pour la période au 20/08/2026",
      confidence: 0.3,
      box: { x: 0.1, y: 0.3, width: expect.closeTo(0.5), height: expect.closeTo(0.03) },
    });
  });

  it("gives each line of a pattern-less list its own evidence", async () => {
    const pdf = new MockPdfEngine([
      [
        token("first", box(0.1, 0.1), 0, "ocr", 0.9),
        token("line", box(0.25, 0.1), 0, "ocr", 0.8),
        token("second", box(0.1, 0.2), 1, "ocr", 0.7),
      ],
    ]);
    const profile = defineProfile({
      id: "lines",
      version: "1",
      languages: ["eng"],
      schema: z.object({ lines: z.array(z.string()) }),
      fields: { lines: field.list({ select: select.region({ x: 0, y: 0, width: 1, height: 1 }) }) },
    });

    const result = await createScribe({ pdf }).parse(new Uint8Array([1]), profile, {
      ocr: "never",
    });

    expect(result.data.lines).toEqual(["first line", "second"]);
    expect(result.evidence["/lines"]?.map((item) => [item.text, item.confidence])).toEqual([
      ["first line", 0.8],
      ["second", 0.7],
    ]);
  });
});
