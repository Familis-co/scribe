import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScribe,
  defineProfile,
  field,
  select,
  transform,
  ValidationError,
} from "../src/index.js";
import { box, MockPdfEngine, token } from "./helpers.js";

describe("declarative profiles", () => {
  it("extracts nested values, lists, transforms and evidence", async () => {
    const pdf = new MockPdfEngine([
      [
        token("Invoice", box(0.1, 0.1), 0),
        token("INV-2026-0042", box(0.36, 0.1, 0.2), 0),
        token("Date", box(0.1, 0.2), 1),
        token("23/09/2026", box(0.36, 0.2, 0.16), 1),
        token("Total", box(0.1, 0.3), 2),
        token("1 234,50 EUR", box(0.36, 0.3, 0.2), 2),
        token("Tags", box(0.1, 0.4), 3),
        token("consulting, support", box(0.36, 0.4, 0.25), 3),
      ],
    ]);
    const schema = z.object({
      invoiceNumber: z.string(),
      issuedAt: z.iso.date(),
      totals: z.object({ gross: z.number() }),
      tags: z.array(z.string()),
    });
    const profile = defineProfile({
      id: "invoice",
      version: "1",
      languages: ["fra"],
      schema,
      fields: {
        invoiceNumber: field.text({
          select: select.relativeToAnchor({
            text: "Invoice",
            offset: box(0.24, -0.01, 0.3, 0.06),
          }),
          transforms: [transform.trim()],
        }),
        issuedAt: field.text({
          select: select.region(box(0.3, 0.18, 0.3, 0.08), 1),
          pattern: /(\d{2}\/\d{2}\/\d{4})/u,
          group: 1,
          transforms: [transform.date("DD/MM/YYYY")],
        }),
        totals: {
          gross: field.text({
            select: select.region(box(0.3, 0.28, 0.35, 0.08), 1),
            pattern: /([\d ]+,\d{2})/u,
            group: 1,
            transforms: [transform.number({ decimalSeparator: ",", groupSeparators: [" "] })],
          }),
        },
        tags: field.list({
          select: select.region(box(0.3, 0.38, 0.4, 0.08), 1),
          pattern: /([a-z]+)/giu,
          group: 1,
          transforms: [transform.trim()],
        }),
      },
    });

    const scribe = createScribe({ pdf });
    const result = await scribe.parse(new Uint8Array([1]), profile, { ocr: "never" });

    expect(result.data).toEqual({
      invoiceNumber: "INV-2026-0042",
      issuedAt: "2026-09-23",
      totals: { gross: 1234.5 },
      tags: ["consulting", "support"],
    });
    expect(result.evidence["/totals/gross"]?.[0]).toMatchObject({
      page: 1,
      method: "native",
      transformations: ["number"],
    });
  });

  it("awaits asynchronous Standard Schema validation", async () => {
    const pdf = new MockPdfEngine([[token("BAD", box(0.1, 0.1))]]);
    const schema = z.object({ code: z.string().refine(async (value) => value === "OK", "Not OK") });
    const profile = defineProfile({
      id: "async",
      version: "1",
      languages: ["eng"],
      schema,
      fields: { code: field.text({ select: select.region(box(0, 0, 1, 1)) }) },
    });

    await expect(
      createScribe({ pdf }).parse(new Uint8Array([1]), profile, { ocr: "never" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("flags low-confidence OCR and only corrects against explicit candidates", async () => {
    const pdf = new MockPdfEngine([
      [
        token("OLIVIER JEAN-LOUTS", box(0.2, 0.2, 0.3), 0, "ocr", 0.62),
        token("REF-42", box(0.2, 0.5, 0.2), 1, "ocr", 0.99),
      ],
    ]);
    const profile = defineProfile({
      id: "known-person",
      version: "1",
      languages: ["fra"],
      schema: z.object({
        person: z.literal("OLIVIER JEAN-LOUIS"),
        reference: z.literal("REF-42"),
      }),
      fields: {
        person: field.text({
          select: select.region(box(0.1, 0.1, 0.6, 0.3), 1),
          warnBelowConfidence: 0.9,
          transforms: [transform.closestMatch(["OLIVIER JEAN-LOUIS"], { maxDistance: 1 })],
        }),
        reference: field.text({
          select: select.region(box(0.1, 0.45, 0.5, 0.15), 1),
        }),
      },
    });

    const result = await createScribe({ pdf }).parse(new Uint8Array([1]), profile, {
      ocr: "never",
    });

    expect(result.data.person).toBe("OLIVIER JEAN-LOUIS");
    expect(result.data.reference).toBe("REF-42");
    expect(result.evidence["/person"]?.[0]).toMatchObject({
      text: "OLIVIER JEAN-LOUTS",
      confidence: 0.62,
      transformations: ["closestMatch"],
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LOW_FIELD_CONFIDENCE", path: "/person" }),
    );
  });

  it("validates confidence and closest-match configuration", () => {
    expect(() =>
      field.text({ select: select.region(box(0, 0, 1, 1)), warnBelowConfidence: 1.1 }),
    ).toThrow(RangeError);
    expect(() => transform.closestMatch([])).toThrow(TypeError);
    expect(() => transform.closestMatch(["known"], { maxDistance: -1 })).toThrow(RangeError);
  });
});
