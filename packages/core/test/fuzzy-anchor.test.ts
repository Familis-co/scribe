import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScribe,
  defineProfile,
  field,
  select,
  type ExtractionResult,
  type TextSelector,
  type TextToken,
} from "../src/index.js";
import { fuzzyKey, similarity } from "../src/fuzzy.js";
import { box, MockPdfEngine, token } from "./helpers.js";

/**
 * Extracts a single optional field with a selector from native pages.
 *
 * @param pages - Native tokens per page
 * @param selector - Selector under test
 * @returns The full extraction result
 */
async function extract(
  pages: readonly (readonly TextToken[])[],
  selector: TextSelector,
): Promise<ExtractionResult<{ value?: string | undefined }>> {
  const profile = defineProfile({
    id: "fuzzy-anchor",
    version: "1",
    languages: ["fra"],
    schema: z.object({ value: z.string().optional() }),
    fields: { value: field.text({ select: selector, required: false }) },
  });
  return createScribe({ pdf: new MockPdfEngine(pages) }).parse(new Uint8Array([1]), profile, {
    ocr: "never",
  });
}

/** An OCR'd header whose two labels were each misread by a character or two. */
const damagedHeader = [
  token("Cossier", box(0.1, 0.1, 0.08), 0),
  token("N°:", box(0.19, 0.1, 0.03), 0),
  token("2026-0042", box(0.25, 0.1, 0.1), 0),
  token("Conceme:", box(0.5, 0.1, 0.1), 0),
  token("JANE", box(0.62, 0.1, 0.06), 0),
  token("DOE", box(0.69, 0.1, 0.05), 0),
  token("Date:", box(0.1, 0.15, 0.05), 1),
  token("20/09/2026", box(0.2, 0.15, 0.1), 1),
];

describe("fuzzy similarity", () => {
  it("compares labels without case, diacritics, punctuation or spaces", () => {
    expect(fuzzyKey("Dossier N°:", false)).toBe("dossiern");
    expect(fuzzyKey("Durée", false)).toBe("duree");
    expect(similarity(fuzzyKey("Cossier N°:", false), fuzzyKey("Dossier N°:", false))).toBe(0.875);
    expect(similarity(fuzzyKey("Conceme:", false), fuzzyKey("Concerne:", false))).toBe(0.75);
    expect(similarity(fuzzyKey("Date:", false), fuzzyKey("Dossier N°:", false))).toBeLessThan(0.7);
  });
});

describe("fuzzy anchors", () => {
  it("matches OCR-damaged labels and stops at a fuzzy stopAt", async () => {
    const reference = await extract(
      [damagedHeader],
      select.afterAnchor({ text: "Dossier N°:", stopAt: "Concerne:", fuzzy: 0.7 }),
    );
    expect(reference.data.value).toBe("2026-0042");

    const subject = await extract(
      [damagedHeader],
      select.afterAnchor({ text: "Concerne:", fuzzy: 0.7 }),
    );
    expect(subject.data.value).toBe("JANE DOE");
  });

  it("records the matched label and its score as evidence", async () => {
    const result = await extract(
      [damagedHeader],
      select.afterAnchor({ text: "Dossier N°:", stopAt: "Concerne:", fuzzy: 0.7 }),
    );
    expect(result.evidence["/value"]?.[0]).toMatchObject({
      text: "2026-0042",
      anchor: { text: "Cossier N°:", score: 0.875 },
    });
  });

  it("does not match an unrelated label", async () => {
    const result = await extract(
      [damagedHeader.filter((item) => item.lineIndex === 1)],
      select.afterAnchor({ text: "Dossier N°:", fuzzy: 0.7 }),
    );
    expect(result.data.value).toBeUndefined();
  });

  it("matches a label split across several tokens", async () => {
    const split = [
      token("Adresse", box(0.1, 0.1, 0.07), 0),
      token("de", box(0.18, 0.1, 0.02), 0),
      token("livraisom", box(0.21, 0.1, 0.08), 0),
      token(":", box(0.3, 0.1, 0.01), 0),
      token("Paris", box(0.35, 0.1, 0.06), 0),
    ];
    const result = await extract(
      [split],
      select.afterAnchor({ text: "Adresse de livraison :", fuzzy: 0.8 }),
    );
    expect(result.data.value).toBe("Paris");
    expect(result.evidence["/value"]?.[0]?.anchor?.text).toBe("Adresse de livraisom :");
  });

  it("keeps exact matching without fuzzy", async () => {
    const result = await extract(
      [damagedHeader],
      select.afterAnchor({ text: "Dossier N°:", stopAt: "Concerne:" }),
    );
    expect(result.data.value).toBeUndefined();

    const exact = await extract(
      [damagedHeader],
      select.afterAnchor({ text: "Date:", stopAt: "Concerne:" }),
    );
    expect(exact.data.value).toBe("20/09/2026");
    expect(exact.evidence["/value"]?.[0]).not.toHaveProperty("anchor");
  });

  it("keeps a pattern anchor exact when fuzzy is set", async () => {
    const result = await extract(
      [damagedHeader],
      select.afterAnchor({ text: /Dossier N°:/u, fuzzy: 0.5 }),
    );
    expect(result.data.value).toBeUndefined();
  });

  it("ranks matches by score, then leftmost, then top", async () => {
    const lines = [
      token("Totai", box(0.1, 0.1, 0.06), 0),
      token("1", box(0.2, 0.1, 0.05), 0),
      token("Total", box(0.1, 0.2, 0.06), 1),
      token("2", box(0.2, 0.2, 0.05), 1),
      token("Total", box(0.05, 0.3, 0.06), 2),
      token("3", box(0.2, 0.3, 0.05), 2),
    ];
    const first = await extract([lines], select.afterAnchor({ text: "Total", fuzzy: 0.7 }));
    expect(first.data.value).toBe("3");
    const second = await extract(
      [lines],
      select.afterAnchor({ text: "Total", fuzzy: 0.7, occurrence: 1 }),
    );
    expect(second.data.value).toBe("2");
    const third = await extract(
      [lines],
      select.afterAnchor({ text: "Total", fuzzy: 0.7, occurrence: 2 }),
    );
    expect(third.data.value).toBe("1");
  });

  it("offsets a relative box from a fuzzy anchor", async () => {
    const result = await extract(
      [
        [
          token("Totat", box(0.1, 0.5, 0.06), 0),
          token("TTC", box(0.17, 0.5, 0.04), 0),
          token("99,00", box(0.6, 0.5, 0.08), 0),
        ],
      ],
      select.relativeToAnchor({
        text: "Total TTC",
        fuzzy: 0.8,
        offset: { x: 0.4, y: -0.01, width: 0.3, height: 0.05 },
      }),
    );
    expect(result.data.value).toBe("99,00");
    expect(result.evidence["/value"]?.[0]?.anchor).toEqual({ text: "Totat TTC", score: 0.875 });
  });

  it("rejects an out-of-range threshold", () => {
    for (const fuzzy of [0, -0.1, 1.1, Number.NaN]) {
      expect(() => select.afterAnchor({ text: "Total", fuzzy })).toThrow(RangeError);
      expect(() => select.relativeToAnchor({ text: "Total", fuzzy, offset: box(0, 0) })).toThrow(
        RangeError,
      );
      expect(() => select.belowAnchor({ text: "Total", fuzzy })).toThrow(RangeError);
    }
    expect(select.afterAnchor({ text: "Total" })).not.toHaveProperty("fuzzy");
  });
});

describe("select.belowAnchor", () => {
  /** Two labels side by side, each with a two-line value printed under it. */
  const form = [
    token("Livraison", box(0.1, 0.1, 0.1, 0.02), 0),
    token("Facturation", box(0.5, 0.1, 0.12, 0.02), 0),
    token("12", box(0.1, 0.125, 0.03, 0.02), 1),
    token("rue", box(0.14, 0.125, 0.04, 0.02), 1),
    token("Haute", box(0.19, 0.125, 0.06, 0.02), 1),
    token("8", box(0.5, 0.125, 0.02, 0.02), 1),
    token("quai", box(0.53, 0.125, 0.05, 0.02), 1),
    token("Bas", box(0.59, 0.125, 0.04, 0.02), 1),
    token("75001", box(0.1, 0.15, 0.06, 0.02), 2),
    token("Paris", box(0.17, 0.15, 0.06, 0.02), 2),
    token("69001", box(0.5, 0.15, 0.06, 0.02), 2),
    token("Lyon", box(0.57, 0.15, 0.05, 0.02), 2),
    token("Signature", box(0.1, 0.4, 0.1, 0.02), 3),
  ];

  it("selects the next line only, within the anchor's column", async () => {
    const left = await extract([form], select.belowAnchor({ text: "Livraison" }));
    expect(left.data.value).toBe("12 rue Haute");
    const right = await extract([form], select.belowAnchor({ text: "Facturation" }));
    expect(right.data.value).toBe("8 quai Bas");
  });

  it("selects up to maxLines lines", async () => {
    const result = await extract([form], select.belowAnchor({ text: "Livraison", maxLines: 5 }));
    expect(result.data.value).toBe("12 rue Haute\n75001 Paris");
  });

  it("selects nothing when the next line is farther than maxDistance", async () => {
    const spaced = [
      token("Nom", box(0.1, 0.1, 0.05, 0.02), 0),
      token("Martin", box(0.1, 0.3, 0.08, 0.02), 1),
    ];
    const far = await extract([spaced], select.belowAnchor({ text: "Nom" }));
    expect(far.data.value).toBeUndefined();
    const near = await extract([spaced], select.belowAnchor({ text: "Nom", maxDistance: 0.2 }));
    expect(near.data.value).toBe("Martin");
  });

  it("keeps a value wider than its label when no label sits to its left", async () => {
    const centered = [
      token("Client", box(0.3, 0.1, 0.06, 0.02), 0),
      token("Jean-Pierre", box(0.2, 0.125, 0.12, 0.02), 1),
      token("Martin", box(0.33, 0.125, 0.07, 0.02), 1),
    ];
    const result = await extract([centered], select.belowAnchor({ text: "Client" }));
    expect(result.data.value).toBe("Jean-Pierre Martin");
  });

  it("matches its anchor fuzzily", async () => {
    const result = await extract([form], select.belowAnchor({ text: "Facturatlon", fuzzy: 0.8 }));
    expect(result.data.value).toBe("8 quai Bas");
    expect(result.evidence["/value"]?.[0]?.anchor?.text).toBe("Facturation");
  });

  it("rejects invalid line counts and distances", () => {
    expect(() => select.belowAnchor({ text: "A", maxLines: 0 })).toThrow(RangeError);
    expect(() => select.belowAnchor({ text: "A", maxLines: 1.5 })).toThrow(RangeError);
    expect(() => select.belowAnchor({ text: "A", maxDistance: -1 })).toThrow(RangeError);
    expect(select.belowAnchor({ text: "A" })).toEqual({
      kind: "belowAnchor",
      text: "A",
      page: "any",
      occurrence: 0,
      caseSensitive: false,
      maxLines: 1,
    });
  });
});
