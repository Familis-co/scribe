import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScribe,
  defineProfile,
  ExtractionError,
  field,
  select,
  transform,
  type OcrRegion,
  type TableOptions,
  type TextToken,
} from "../src/index.js";
import { box, MockOcrEngine, MockPdfEngine, token } from "./helpers.js";

/** Reads a `DD/MM/YYYY` date anywhere in a cell, ignoring a weekday wrapped into it. */
const looseDate = transform.custom("looseDate", (value) => {
  const match = /(\d{2})\/(\d{2})\/(\d{4})/u.exec(String(value));
  if (!match) throw new TypeError(`No date in "${String(value)}".`);
  return `${match[3]}-${match[2]}-${match[1]}`;
});

/** Validates an `HH:MM` clock time. */
const clockTime = transform.custom("clockTime", (value) => {
  if (!/^\d{2}:\d{2}$/u.test(String(value))) throw new TypeError(`Not a time: "${String(value)}".`);
  return value;
});

/** Converts an `HH:MM` duration to minutes. */
const durationMinutes = transform.custom("durationMinutes", (value) => {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours! * 60 + minutes!;
});

/** Column x positions shared by the header and the rows. */
const x = { date: 0.08, start: 0.3, end: 0.45, duration: 0.6, worker: 0.75 };

/**
 * Builds a positioned cell token.
 *
 * @param text - Cell text
 * @param left - Horizontal position
 * @param y - Vertical position
 * @param source - Token source
 * @param confidence - OCR confidence
 * @returns The token
 */
const cell = (
  text: string,
  left: number,
  y: number,
  source: "native" | "ocr" = "native",
  confidence = 0.95,
): TextToken => token(text, box(left, y, 0.08, 0.012), 0, source, confidence);

/**
 * Builds a table row, leaving out cells given as `undefined`.
 *
 * @param y - Vertical position of the row
 * @param values - Cell text by column, with an optional weekday before the date
 * @param source - Token source
 * @returns The row tokens
 */
const row = (
  y: number,
  values: {
    weekday?: string;
    date?: string;
    start?: string;
    end?: string;
    duration?: string;
    worker?: string;
  },
  source: "native" | "ocr" = "native",
): TextToken[] =>
  [
    values.weekday === undefined ? undefined : cell(values.weekday, 0.05, y, source),
    values.date === undefined ? undefined : cell(values.date, 0.13, y, source),
    values.start === undefined ? undefined : cell(values.start, x.start, y, source),
    values.end === undefined ? undefined : cell(values.end, x.end, y, source),
    values.duration === undefined ? undefined : cell(values.duration, x.duration, y, source),
    values.worker === undefined ? undefined : cell(values.worker, x.worker, y, source),
  ].filter((item) => item !== undefined);

/**
 * Builds the schedule header line.
 *
 * @param source - Token source
 * @returns The header tokens
 */
const headerLine = (source: "native" | "ocr" = "native"): TextToken[] => [
  cell("Date", x.date, 0.36, source),
  cell("Début", x.start, 0.36, source),
  cell("Fin", x.end, 0.36, source),
  cell("Durée", x.duration, 0.36, source),
  cell("Travailleur", x.worker, 0.36, source),
];

/**
 * Builds the schedule from the issue: the last row's weekday is wrapped onto its own line above it.
 *
 * @param source - Token source
 * @returns Tokens of the header and four visits
 */
const schedule = (source: "native" | "ocr" = "native"): TextToken[] => [
  ...headerLine(source),
  ...row(
    0.4,
    {
      weekday: "Lundi",
      date: "14/09/2026",
      start: "08:00",
      end: "12:00",
      duration: "04:00",
      worker: "WORKER",
    },
    source,
  ),
  ...row(
    0.44,
    {
      weekday: "Mardi",
      date: "15/09/2026",
      start: "13:00",
      end: "14:30",
      duration: "01:30",
      worker: "WORKER",
    },
    source,
  ),
  ...row(0.48, { weekday: "Samedi", date: "19/09/2026", start: "09:00", worker: "WORKER" }, source),
  cell("Dimanche", 0.05, 0.511, source),
  ...row(
    0.526,
    { date: "20/09/2026", start: "18:30", end: "19:30", duration: "01:00", worker: "WORKER" },
    source,
  ),
];

/** Visit table columns. */
const columns: TableOptions["columns"] = [
  { key: "date", label: /^Date$/iu, transforms: [looseDate] },
  { key: "start", label: /^Début$/iu, transforms: [clockTime] },
  { key: "end", label: /^Fin$/iu, transforms: [clockTime], required: false },
  { key: "durationMinutes", label: /^Durée$/iu, transforms: [durationMinutes], required: false },
  { key: "worker", label: "travailleur", transforms: [transform.normalizeWhitespace()] },
];

/**
 * Builds a schedule profile.
 *
 * @param options - Overrides for the table options
 * @param regions - Optional declared OCR regions
 * @returns The profile
 */
const scheduleProfile = (options: Partial<TableOptions> = {}, regions?: readonly OcrRegion[]) =>
  defineProfile({
    id: "schedule",
    version: "1",
    languages: ["fra"],
    schema: z.object({
      reference: z.string().optional(),
      visits: z
        .array(
          z.object({
            date: z.string().nullable(),
            start: z.string().nullable(),
            end: z.string().nullable(),
            durationMinutes: z.number().nullable(),
            worker: z.string(),
          }),
        )
        .optional(),
    }),
    fields: {
      reference: field.text({ select: select.afterAnchor({ text: "Reference" }), required: false }),
      visits: field.table({
        select: select.region({ x: 0.02, y: 0.34, width: 0.9, height: 0.3 }, 1),
        columns,
        rowKey: "start",
        ...options,
      }),
    },
    ...(regions ? { ocr: { regions } } : {}),
  });

/**
 * Parses native tokens with the schedule profile.
 *
 * @param tokens - Tokens of the only page
 * @param options - Overrides for the table options
 * @returns The extraction result
 */
const parse = (tokens: readonly TextToken[], options?: Partial<TableOptions>) =>
  createScribe({ pdf: new MockPdfEngine([tokens]) }).parse(
    new Uint8Array([1]),
    scheduleProfile(options),
    { ocr: "never" },
  );

describe("field.table", () => {
  it("merges a cell wrapped above its row into that row", async () => {
    const result = await parse(schedule());

    expect(result.data.visits).toEqual([
      { date: "2026-09-14", start: "08:00", end: "12:00", durationMinutes: 240, worker: "WORKER" },
      { date: "2026-09-15", start: "13:00", end: "14:30", durationMinutes: 90, worker: "WORKER" },
      { date: "2026-09-19", start: "09:00", end: null, durationMinutes: null, worker: "WORKER" },
      { date: "2026-09-20", start: "18:30", end: "19:30", durationMinutes: 60, worker: "WORKER" },
    ]);
    expect(result.evidence["/visits/3/date"]).toEqual([
      {
        page: 1,
        box: {
          x: 0.05,
          y: 0.511,
          width: expect.closeTo(0.16),
          height: expect.closeTo(0.027),
        },
        text: "Dimanche 20/09/2026",
        method: "native",
        transformations: ["looseDate"],
      },
    ]);
    expect(result.evidence["/visits/2/end"]).toBeUndefined();
    expect(result.diagnostics.filter((item) => item.level === "warning")).toEqual([]);
  });

  it("drops a row missing a required cell and reports it", async () => {
    const result = await parse([
      ...schedule(),
      ...row(0.56, { date: "21/09/2026", start: "10:00", end: "11:00", duration: "01:00" }),
    ]);

    expect(result.data.visits).toHaveLength(4);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "TABLE_ROW_DROPPED",
        page: 1,
        path: "/visits",
        message: expect.stringContaining("worker"),
      }),
    );
  });

  it("sets a cell to null when its transform fails and points the diagnostic at the cell", async () => {
    const tokens = schedule().map((item) =>
      item.text === "14:30" ? { ...item, text: "14h30" } : item,
    );

    const result = await parse(tokens);

    expect(result.data.visits?.[1]).toMatchObject({ start: "13:00", end: null });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "TRANSFORM_FAILED", path: "/visits/1/end" }),
    );
    expect(result.evidence["/visits/1/end"]?.[0]?.text).toBe("14h30");
  });

  it("filters rows and numbers evidence after filtering", async () => {
    const result = await parse(schedule(), { filter: (visit) => visit.end !== null });

    expect(result.data.visits?.map((visit) => visit.date)).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-20",
    ]);
    expect(result.evidence["/visits/2/date"]?.[0]?.text).toBe("Dimanche 20/09/2026");
    expect(result.evidence["/visits/3/date"]).toBeUndefined();
  });

  it("reports a missing header like a missing field", async () => {
    const body = schedule().slice(5);

    await expect(parse(body)).rejects.toBeInstanceOf(ExtractionError);
    const optional = await parse(body, { required: false });
    expect(optional.data.visits).toBeUndefined();
    expect(optional.diagnostics).toContainEqual(
      expect.objectContaining({ level: "info", code: "FIELD_NOT_FOUND", path: "/visits" }),
    );
  });

  it("returns no rows when the header has nothing below it", async () => {
    expect((await parse(headerLine())).data.visits).toEqual([]);
  });

  it("works on OCR tokens and warns about low-confidence cells", async () => {
    const tokens = schedule("ocr").map((item) =>
      item.text === "15/09/2026" ? { ...item, confidence: 0.4 } : item,
    );
    const pdf = new MockPdfEngine([[]]);
    const ocr = new MockOcrEngine([{ tokens }]);

    const result = await createScribe({ pdf, ocr }).parse(
      new Uint8Array([1]),
      scheduleProfile({ warnBelowConfidence: 0.8 }),
      { ocr: "always" },
    );

    expect(result.data.visits).toHaveLength(4);
    expect(result.evidence["/visits/1/date"]?.[0]).toMatchObject({
      method: "ocr",
      confidence: 0.4,
    });
    const warnings = result.diagnostics.filter((item) => item.code === "LOW_FIELD_CONFIDENCE");
    expect(warnings.map((item) => item.path)).toEqual(["/visits/1/date"]);
  });

  it("works on a mixed page where the header band is OCR'd", async () => {
    const gray = {
      data: new Uint8Array(100 * 100),
      width: 100,
      height: 100,
      format: "gray8",
    } as const;
    const pdf = new MockPdfEngine([schedule()], [gray]);
    const ocr = new MockOcrEngine([
      {
        tokens: [
          token("Reference", box(0.1, 0.2, 0.3, 0.3), 0, "ocr"),
          token("ABC-42", box(0.5, 0.2, 0.3, 0.3), 0, "ocr"),
        ],
      },
    ]);
    const band: OcrRegion = { page: 1, box: { x: 0, y: 0.1, width: 1, height: 0.1 } };

    const result = await createScribe({ pdf, ocr }).parse(
      new Uint8Array([1]),
      scheduleProfile({}, [band]),
      { ocr: "always" },
    );

    expect(result.pages[0]?.source).toBe("mixed");
    expect(result.data.reference).toBe("ABC-42");
    expect(result.data.visits).toHaveLength(4);
    expect(result.data.visits?.[3]?.date).toBe("2026-09-20");
  });

  it("matches labels spanning several tokens", async () => {
    const tokens = schedule().flatMap((item) =>
      item.text === "Travailleur"
        ? [
            { ...item, text: "Nom" },
            { ...item, text: "complet", box: { ...item.box, x: item.box.x + 0.09 } },
          ]
        : [item],
    );
    const renamed = columns.map((column) =>
      column.key === "worker" ? { ...column, label: /^Nom complet$/iu } : column,
    );

    expect((await parse(tokens, { columns: renamed })).data.visits).toHaveLength(4);
  });

  it("validates its configuration", () => {
    const region = select.region(box(0, 0, 1, 1));
    expect(() => field.table({ select: region, columns: [], rowKey: "a" })).toThrow(TypeError);
    expect(() =>
      field.table({ select: region, columns: [{ key: "a", label: "A" }], rowKey: "b" }),
    ).toThrow(TypeError);
    expect(() =>
      field.table({
        select: region,
        columns: [
          { key: "a", label: "A" },
          { key: "a", label: "B" },
        ],
        rowKey: "a",
      }),
    ).toThrow(TypeError);
  });
});
