import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScribe,
  defineProfile,
  field,
  select,
  type TextSelector,
  type TextToken,
} from "../src/index.js";
import { box, MockOcrEngine, MockPdfEngine, token } from "./helpers.js";

/**
 * Extracts a single field with a selector from native pages.
 *
 * @param pages - Native tokens per page
 * @param selector - Selector under test
 * @param pattern - Optional capture pattern
 * @returns The extracted value, or `undefined` when the optional field is missing
 */
async function extract(
  pages: readonly (readonly TextToken[])[],
  selector: TextSelector,
  pattern?: RegExp,
): Promise<string | undefined> {
  const profile = defineProfile({
    id: "after-anchor",
    version: "1",
    languages: ["fra"],
    schema: z.object({ value: z.string().optional() }),
    fields: {
      value: field.text({ select: selector, required: false, ...(pattern ? { pattern } : {}) }),
    },
  });
  const result = await createScribe({ pdf: new MockPdfEngine(pages) }).parse(
    new Uint8Array([1]),
    profile,
    { ocr: "never" },
  );
  return result.data.value;
}

/** A label/value line followed by a line starting with an uppercase letter. */
const header = [
  token("Concerne", box(0.1, 0.2, 0.1), 0),
  token(":", box(0.2, 0.2, 0.01), 0),
  token("JANE", box(0.25, 0.2, 0.08), 0),
  token("DOE", box(0.34, 0.2, 0.06), 0),
  token("Date", box(0.6, 0.2, 0.06), 0),
  token(":", box(0.66, 0.2, 0.01), 0),
  token("20/09/2026", box(0.68, 0.2, 0.12), 0),
  token("Numéro", box(0.1, 0.215, 0.1), 1),
  token("42", box(0.25, 0.215, 0.05), 1),
];

/**
 * Builds a `Ref:` label followed by its value on one line.
 *
 * @param value - Value printed after the label
 * @param y - Vertical position of the line
 * @param line - Line index
 * @returns The label and value tokens
 */
const refLine = (value: string, y: number, line: number): TextToken[] => [
  token("Ref:", box(0.1, y, 0.05), line),
  token(value, box(0.2, y, 0.1), line),
];

describe("select.afterAnchor", () => {
  it("never selects tokens from the next line", async () => {
    const value = await extract(
      [header.filter((item) => item.lineIndex === 1 || item.box.x < 0.5)],
      select.afterAnchor({ text: /Concerne\s*:/iu }),
      /[A-Z\s]+/u,
    );
    expect(value).toBe("JANE DOE");
  });

  it("stops before a stopAt match spanning several tokens", async () => {
    expect(
      await extract([header], select.afterAnchor({ text: /Concerne\s*:/iu, stopAt: /Date\s*:/iu })),
    ).toBe("JANE DOE");
  });

  it("selects the rest of the line when stopAt does not match", async () => {
    expect(await extract([header], select.afterAnchor({ text: "date :", stopAt: "Total" }))).toBe(
      "20/09/2026",
    );
  });

  it("matches literal anchors and stops case-insensitively by default", async () => {
    expect(await extract([header], select.afterAnchor({ text: "concerne", stopAt: "date" }))).toBe(
      ": JANE DOE",
    );
    expect(
      await extract(
        [header],
        select.afterAnchor({ text: "concerne", stopAt: "date", caseSensitive: true }),
      ),
    ).toBeUndefined();
  });

  it("honors occurrence and page like relativeToAnchor", async () => {
    const pages = [
      [...refLine("A-1", 0.1, 0), ...refLine("A-2", 0.3, 1)],
      [...refLine("B-1", 0.1, 0), ...refLine("B-2", 0.3, 1)],
    ];

    expect(await extract(pages, select.afterAnchor({ text: "Ref:" }))).toBe("A-1\nB-1");
    expect(await extract(pages, select.afterAnchor({ text: "Ref:", occurrence: 1 }))).toBe(
      "A-2\nB-2",
    );
    expect(await extract(pages, select.afterAnchor({ text: "Ref:", page: 2, occurrence: 1 }))).toBe(
      "B-2",
    );
    expect(await extract(pages, select.afterAnchor({ text: "Ref:", occurrence: 2 }))).toBe(
      undefined,
    );
  });

  it("returns nothing when the anchor ends its line", async () => {
    expect(
      await extract([[token("Reference:", box(0.1, 0.1), 0)]], select.afterAnchor({ text: "Ref" })),
    ).toBeUndefined();
  });

  it("works on OCR tokens whose boxes shift vertically within a line", async () => {
    const pdf = new MockPdfEngine([[]]);
    const ocr = new MockOcrEngine([
      {
        tokens: [
          token("Reference", box(0.1, 0.2, 0.1), 0, "ocr"),
          token(":", box(0.2, 0.203, 0.01), 0, "ocr"),
          token("1234567", box(0.22, 0.197, 0.12), 0, "ocr"),
          token("Nom", box(0.1, 0.222, 0.06), 1, "ocr"),
        ],
      },
    ]);
    const profile = defineProfile({
      id: "ocr-after-anchor",
      version: "1",
      languages: ["fra"],
      schema: z.object({ reference: z.string() }),
      fields: {
        reference: field.text({ select: select.afterAnchor({ text: /Reference\s*:/iu }) }),
      },
    });

    const result = await createScribe({ pdf, ocr }).parse(new Uint8Array([1]), profile, {
      ocr: "always",
    });

    expect(result.data.reference).toBe("1234567");
    expect(result.evidence["/reference"]?.[0]).toMatchObject({ method: "ocr", text: "1234567" });
  });
});
