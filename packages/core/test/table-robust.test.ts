import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScribe,
  defineProfile,
  ExtractionError,
  field,
  select,
  type PageRules,
  type TableOptions,
  type TextToken,
} from "../src/index.js";
import { box, MockPdfEngine, token } from "./helpers.js";

/**
 * Builds a table cell token whose width follows its text, a hundredth of the page per character.
 *
 * @param text - Cell text
 * @param left - Horizontal position
 * @param y - Vertical position
 * @returns The token
 */
const cell = (text: string, left: number, y: number): TextToken =>
  token(text, box(left, y, text.length * 0.01, 0.012));

/**
 * Builds vertical rules spanning the whole table area.
 *
 * @param positions - Horizontal rule positions
 * @returns Page rules without horizontal rules
 */
const verticalRules = (...positions: number[]): PageRules => ({
  vertical: positions.map((position) => ({ position, start: 0.15, end: 0.6 })),
  horizontal: [],
});

/** Day, start, and worker columns, keyed by start. */
const columns: TableOptions["columns"] = [
  { key: "day", label: "Jour" },
  { key: "start", label: "Début" },
  { key: "worker", label: "Travailleur" },
];

/** Header and three rows spaced 0.05 apart. */
const table = [
  cell("Jour", 0.1, 0.2),
  cell("Début", 0.3, 0.2),
  cell("Travailleur", 0.5, 0.2),
  cell("Lundi", 0.1, 0.25),
  cell("08:00", 0.3, 0.25),
  cell("DUPONT", 0.5, 0.25),
  cell("Mardi", 0.1, 0.3),
  cell("10:00", 0.3, 0.3),
  cell("MARTIN", 0.5, 0.3),
  cell("Mercredi", 0.1, 0.35),
  cell("14:00", 0.3, 0.35),
  cell("DURAND", 0.5, 0.35),
];

/**
 * Extracts the table from one native page.
 *
 * @param tokens - Tokens of the page
 * @param options - Table option overrides
 * @param rules - Rules the page reports, if any
 * @returns The extraction result and the mock PDF engine
 */
async function parse(
  tokens: readonly TextToken[],
  options: Partial<TableOptions> = {},
  rules?: PageRules,
) {
  const pdf = new MockPdfEngine([tokens], [], [rules]);
  const profile = defineProfile({
    id: "robust-table",
    version: "1",
    languages: ["fra"],
    schema: z.object({
      rows: z.array(
        z.object({
          day: z.string().nullable(),
          start: z.string().nullable(),
          worker: z.string().nullable(),
        }),
      ),
    }),
    fields: {
      rows: field.table({
        select: select.region({ x: 0, y: 0.15, width: 1, height: 0.45 }, 1),
        columns,
        rowKey: "start",
        ...options,
      }),
    },
  });
  const result = await createScribe({ pdf }).parse(new Uint8Array([1]), profile, { ocr: "never" });
  return { result, pdf };
}

describe("field.table row tolerance", () => {
  const footer = [cell("Total", 0.1, 0.4), cell("12h", 0.5, 0.4)];

  it("merges a line below the table into the last row without rowTolerance", async () => {
    const { result } = await parse([...table, ...footer]);
    expect(result.data.rows.at(-1)).toEqual({
      day: "Mercredi Total",
      start: "14:00",
      worker: "DURAND 12h",
    });
  });

  it("drops and reports a line one row pitch below the last row", async () => {
    const { result } = await parse([...table, ...footer], { rowTolerance: 0.5 });
    expect(result.data.rows).toEqual([
      { day: "Lundi", start: "08:00", worker: "DUPONT" },
      { day: "Mardi", start: "10:00", worker: "MARTIN" },
      { day: "Mercredi", start: "14:00", worker: "DURAND" },
    ]);
    expect(result.diagnostics).toContainEqual({
      level: "info",
      code: "TABLE_LINES_DROPPED",
      message: 'Lines too far from every row of /rows were dropped: "Total 12h".',
      page: 1,
      path: "/rows",
    });
  });

  it("keeps a line wrapped close to its row", async () => {
    const wrapped = [...table, cell("MARIE", 0.5, 0.362)];
    const { result } = await parse(wrapped, { rowTolerance: 0.5 });
    expect(result.data.rows.at(-1)?.worker).toBe("DURAND MARIE");
  });

  it("merges a row key wrapped onto a second line into its row", async () => {
    const wrapped = [...table, cell("(pause)", 0.3, 0.312)];
    const loose = await parse(wrapped);
    expect(loose.result.data.rows).toHaveLength(3);
    expect(loose.result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "TABLE_ROW_DROPPED" }),
    );

    const { result } = await parse(wrapped, { rowTolerance: 0.5 });
    expect(result.data.rows[1]).toEqual({ day: "Mardi", start: "10:00 (pause)", worker: "MARTIN" });
    expect(result.diagnostics.map((item) => item.code)).not.toContain("TABLE_ROW_DROPPED");
  });

  it("rejects a non-positive tolerance", () => {
    expect(() =>
      field.table({
        select: select.region(box(0, 0, 1, 1)),
        columns,
        rowKey: "start",
        rowTolerance: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("field.table header matching", () => {
  const damaged = table.map((item) =>
    item.text === "Travailleur" ? cell("Travai1leur", 0.5, 0.2) : item,
  );

  it("finds an OCR-damaged header label with fuzzy", async () => {
    await expect(parse(damaged)).rejects.toBeInstanceOf(ExtractionError);
    const { result } = await parse(damaged, { fuzzy: 0.8 });
    expect(result.data.rows[0]).toEqual({ day: "Lundi", start: "08:00", worker: "DUPONT" });
  });

  it("nulls a column whose label is missing when half the labels match", async () => {
    const blank = table.filter((item) => item.text !== "Jour");
    await expect(parse(blank)).rejects.toBeInstanceOf(ExtractionError);

    const { result } = await parse(blank, { minColumns: "half" });
    expect(result.data.rows.map((item) => item.day)).toEqual([null, null, null]);
    expect(result.data.rows.map((item) => item.worker)).toEqual(["DUPONT", "MARTIN", "DURAND"]);
    expect(result.diagnostics).toContainEqual({
      level: "warning",
      code: "TABLE_COLUMN_NOT_FOUND",
      message: "No header was found for column day of /rows on page 1; its cells are null.",
      page: 1,
      path: "/rows",
    });
    expect(result.diagnostics.map((item) => item.code)).not.toContain("TABLE_ROW_DROPPED");
  });

  it("requires the row key's label", async () => {
    const noStart = table.filter((item) => item.text !== "Début");
    await expect(parse(noStart, { minColumns: 1 })).rejects.toBeInstanceOf(ExtractionError);
  });

  it("validates minColumns", () => {
    for (const minColumns of [0, 4, 1.5]) {
      expect(() =>
        field.table({
          select: select.region(box(0, 0, 1, 1)),
          columns,
          rowKey: "start",
          minColumns,
        }),
      ).toThrow(RangeError);
    }
  });
});

describe("field.table rules", () => {
  /** A wide name column with a centered header, and a code column whose header is left-aligned. */
  const names = [
    cell("Travailleur", 0.2, 0.2),
    cell("Début", 0.46, 0.2),
    cell("Jean-Pierre", 0.06, 0.25),
    cell("Martin", 0.36, 0.25),
    cell("08:00", 0.46, 0.25),
  ];
  const nameColumns: TableOptions["columns"] = [
    { key: "worker", label: "Travailleur" },
    { key: "start", label: "Début" },
    { key: "day", label: "Jour", required: false },
  ];

  it("uses rules as column boundaries when they separate every header", async () => {
    const midpoints = await parse(names, { columns: nameColumns, minColumns: 2 });
    expect(midpoints.result.data.rows[0]).toMatchObject({
      worker: "Jean-Pierre",
      start: "Martin 08:00",
    });

    const ruled = await parse(
      names,
      { columns: nameColumns, minColumns: 2 },
      verticalRules(0.05, 0.45, 0.9),
    );
    expect(ruled.result.data.rows[0]).toMatchObject({
      worker: "Jean-Pierre Martin",
      start: "08:00",
    });
    expect(ruled.pdf.document.pages[0]?.rulesCount).toBe(1);
  });

  it("falls back to label midpoints when rules do not separate the headers", async () => {
    const { result } = await parse(
      names,
      { columns: nameColumns, minColumns: 2 },
      verticalRules(0.9),
    );
    expect(result.data.rows[0]).toMatchObject({ worker: "Jean-Pierre", start: "Martin 08:00" });
  });

  it("ignores rules with useRules false, and never reads them without a table", async () => {
    const { result, pdf } = await parse(
      names,
      { columns: nameColumns, minColumns: 2, useRules: false },
      verticalRules(0.05, 0.45, 0.9),
    );
    expect(result.data.rows[0]).toMatchObject({ worker: "Jean-Pierre", start: "Martin 08:00" });
    expect(pdf.document.pages[0]?.rulesCount).toBe(0);
  });

  it("splits a token crossing a rule only past 3 characters and a quarter on each side", async () => {
    const merged = [
      cell("Jour", 0.1, 0.2),
      cell("Début", 0.3, 0.2),
      cell("Travailleur", 0.5, 0.2),
      // Overhangs the rule at 0.19 by one letter: kept whole.
      cell("Mercredi", 0.12, 0.25),
      // Crosses the rule at 0.4 with 5 characters on the left and 6 on the right: split.
      cell("10:00DUPONT", 0.35, 0.25),
    ];
    const { result } = await parse(merged, {}, verticalRules(0.05, 0.19, 0.4, 0.8));
    expect(result.data.rows).toEqual([{ day: "Mercredi", start: "10:00", worker: "DUPONT" }]);
    expect(result.evidence["/rows/0/start"]?.[0]?.box).toMatchObject({
      x: 0.35,
      width: expect.closeTo(0.05),
    });
  });
});
