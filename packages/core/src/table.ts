import { centerY, visualLines } from "./lines.js";
import type { TextToken } from "./types.js";

/** Column identity and header label used to lay out a table. */
export interface TableLayoutColumn {
  /** Output key of the column. */
  readonly key: string;
  /** Header label: a literal compared case-insensitively with whole tokens, or a pattern. */
  readonly label: string | RegExp;
}

/** Tokens of one table row, by column key, each cell in reading order. */
export type TableRowTokens = ReadonlyMap<string, readonly TextToken[]>;

/**
 * Tests a header label against the text of a run of tokens.
 *
 * @param text - Space-joined token text
 * @param label - Literal label compared case-insensitively, or a pattern whose `g` flag is ignored
 * @returns `true` when the label matches
 */
function labelMatches(text: string, label: string | RegExp): boolean {
  if (typeof label === "string") return text.toLocaleLowerCase() === label.toLocaleLowerCase();
  return new RegExp(label.source, label.flags.replaceAll("g", "")).test(text);
}

/**
 * Finds the horizontal center of every column label on one line.
 *
 * @remarks
 * Shorter runs of tokens are tried first, so a pattern such as `/Date/` claims the `Date` token
 * rather than a longer run that merely contains it. A token belongs to at most one label.
 *
 * @param line - Tokens of one visual line, left to right
 * @param columns - Columns whose labels must all match
 * @returns Label centers in column order, or `undefined` when a label is missing
 */
function headerCenters(
  line: readonly TextToken[],
  columns: readonly TableLayoutColumn[],
): readonly number[] | undefined {
  const used = new Set<number>();
  const centers: number[] = [];
  for (const column of columns) {
    let found: { start: number; end: number } | undefined;
    for (let length = 1; length <= line.length && !found; length += 1) {
      for (let start = 0; start + length <= line.length && !found; start += 1) {
        const run = line.slice(start, start + length);
        if (run.some((_, offset) => used.has(start + offset))) continue;
        if (labelMatches(run.map((token) => token.text).join(" "), column.label)) {
          found = { start, end: start + length };
        }
      }
    }
    if (!found) return undefined;
    for (let index = found.start; index < found.end; index += 1) used.add(index);
    const first = line[found.start]!;
    const last = line[found.end - 1]!;
    centers.push((first.box.x + last.box.x + last.box.width) / 2);
  }
  return centers;
}

/**
 * Mean vertical center of a line.
 *
 * @param line - Non-empty tokens of one visual line
 * @returns The normalized vertical center
 */
const lineCenter = (line: readonly TextToken[]): number =>
  line.reduce((sum, token) => sum + centerY(token), 0) / line.length;

/**
 * Lays out the tokens of one page as table rows.
 *
 * @remarks
 * 1. The header is the first visual line where every column label matches.
 * 2. Column boundaries sit halfway between adjacent label centers, because values are often wider
 *    than centered labels. Each token below the header goes to the column containing its center.
 * 3. A row starts at every line with a token in the `rowKey` column. Any other line attaches to the
 *    vertically nearest row, which keeps a cell wrapped above its row in that row.
 *
 * @param tokens - Selected tokens of one page, in any order
 * @param columns - Columns with their header labels
 * @param rowKey - Key of the column whose tokens start a new row
 * @returns Row cells from top to bottom, or `undefined` when no header line is found
 */
export function layoutTable(
  tokens: readonly TextToken[],
  columns: readonly TableLayoutColumn[],
  rowKey: string,
): readonly TableRowTokens[] | undefined {
  const lines = visualLines(tokens);
  const headerIndex = lines.findIndex((line) => headerCenters(line, columns) !== undefined);
  if (headerIndex < 0) return undefined;

  const centers = headerCenters(lines[headerIndex]!, columns)!;
  const ordered = columns
    .map((column, index) => ({ key: column.key, center: centers[index]! }))
    .toSorted((left, right) => left.center - right.center);
  const bounds = ordered
    .slice(1)
    .map((column, index) => (ordered[index]!.center + column.center) / 2);
  /**
   * Finds the column containing a horizontal position.
   *
   * @param x - Normalized horizontal position
   * @returns The key of the column whose bounds contain `x`
   */
  const columnAt = (x: number): string => {
    const index = bounds.findIndex((bound) => x < bound);
    return ordered[index < 0 ? ordered.length - 1 : index]!.key;
  };

  const body = lines.slice(headerIndex + 1).map((line) => ({
    center: lineCenter(line),
    cells: line.map((token) => ({ key: columnAt(token.box.x + token.box.width / 2), token })),
  }));
  const rows = body
    .filter((line) => line.cells.some((cell) => cell.key === rowKey))
    .map((line) => ({ center: line.center, cells: new Map<string, TextToken[]>() }));
  if (rows.length === 0) return [];

  for (const line of body) {
    let nearest = rows[0]!;
    for (const row of rows) {
      if (Math.abs(row.center - line.center) < Math.abs(nearest.center - line.center))
        nearest = row;
    }
    for (const { key, token } of line.cells) {
      nearest.cells.set(key, [...(nearest.cells.get(key) ?? []), token]);
    }
  }
  return rows.map((row) => row.cells);
}
