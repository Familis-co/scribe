import { bestWindow, fuzzyKey } from "./fuzzy.js";
import { centerY, visualLines } from "./lines.js";
import type { PageRule, TextToken } from "./types.js";

/** Longest run of tokens compared with a fuzzy header label. */
const FUZZY_HEADER_TOKENS = 3;
/** Row starts closer than this fraction of the row pitch are fragments of one wrapped row. */
const ROW_MERGE_RATIO = 0.6;
/** Rules closer than this normalized distance are one rule drawn twice, such as a box's shared side. */
const RULE_MERGE_DISTANCE = 0.003;
/** Fewest characters on each side of a rule before a token crossing it is split. */
const SPLIT_MIN_CHARACTERS = 3;
/** Smallest share of a token's characters on each side of a rule before it is split. */
const SPLIT_MIN_SHARE = 0.25;
/** Splits text into user-perceived characters, keeping a letter and its accents together. */
const graphemes = new Intl.Segmenter();

/** Column identity and header label used to lay out a table. */
export interface TableLayoutColumn {
  /** Output key of the column. */
  readonly key: string;
  /** Header label: a literal compared case-insensitively with whole tokens, or a pattern. */
  readonly label: string | RegExp;
}

/** Header matching, row, and column options of {@link layoutTable}. */
export interface TableLayoutOptions {
  /** Minimum similarity for a fuzzy literal header label. Omitted, labels match exactly. */
  readonly fuzzy?: number;
  /** Number of labels, the row key's included, that must match on the header line. */
  readonly minColumns: number;
  /** Largest distance between a body line and its row, as a fraction of the median row pitch. */
  readonly rowTolerance?: number;
  /** Vertical rules of the page, used as column boundaries when they separate every header. */
  readonly rules?: readonly PageRule[];
}

/** Tokens of one table row, by column key, each cell in reading order. */
export type TableRowTokens = ReadonlyMap<string, readonly TextToken[]>;

/** Rows laid out by {@link layoutTable}, with what was left out of them. */
export interface TableLayout {
  /** Row cells from top to bottom. */
  readonly rows: readonly TableRowTokens[];
  /** Keys of the columns whose header label was not found, in column order. */
  readonly missingColumns: readonly string[];
  /** Text of the body lines dropped for being too far from every row, from top to bottom. */
  readonly droppedLines: readonly string[];
}

/** A located header label. */
interface HeaderLabel {
  readonly key: string;
  /** Horizontal center of the label's tokens. */
  readonly center: number;
}

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
 * Finds the run of unused tokens holding a header label.
 *
 * @remarks
 * An exact match is tried first, shorter runs before longer ones, so a pattern such as `/Date/`
 * claims the `Date` token rather than a longer run that merely contains it. With `fuzzy`, a literal
 * label that has no exact match falls back to the most similar run of 1 to 3 tokens.
 *
 * @param line - Tokens of one visual line, left to right
 * @param label - Literal or pattern label
 * @param used - Indices of tokens already claimed by another label
 * @param fuzzy - Minimum similarity for a fuzzy literal match, or `undefined` for exact matching
 * @returns The `[start, end)` token range of the label, or `undefined` when it is missing
 */
function findLabel(
  line: readonly TextToken[],
  label: string | RegExp,
  used: ReadonlySet<number>,
  fuzzy: number | undefined,
): { readonly start: number; readonly end: number } | undefined {
  for (let length = 1; length <= line.length; length += 1) {
    for (let start = 0; start + length <= line.length; start += 1) {
      const run = line.slice(start, start + length);
      if (run.some((_, offset) => used.has(start + offset))) continue;
      if (labelMatches(run.map((token) => token.text).join(" "), label)) {
        return { start, end: start + length };
      }
    }
  }
  if (fuzzy === undefined || typeof label !== "string") return undefined;
  const key = fuzzyKey(label, false);
  if (key === "") return undefined;
  return bestWindow(line, key, fuzzy, false, FUZZY_HEADER_TOKENS, (index) => !used.has(index));
}

/**
 * Locates the column labels on one line.
 *
 * @remarks
 * Labels are searched in column order, and a token belongs to at most one label.
 *
 * @param line - Tokens of one visual line, left to right
 * @param columns - Columns whose labels are searched
 * @param fuzzy - Minimum similarity for fuzzy literal labels, or `undefined` for exact matching
 * @returns The labels found, in column order
 */
function locateLabels(
  line: readonly TextToken[],
  columns: readonly TableLayoutColumn[],
  fuzzy: number | undefined,
): readonly HeaderLabel[] {
  const used = new Set<number>();
  const labels: HeaderLabel[] = [];
  for (const column of columns) {
    const found = findLabel(line, column.label, used, fuzzy);
    if (!found) continue;
    for (let index = found.start; index < found.end; index += 1) used.add(index);
    const first = line[found.start]!;
    const last = line[found.end - 1]!;
    labels.push({ key: column.key, center: (first.box.x + last.box.x + last.box.width) / 2 });
  }
  return labels;
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
 * Median of a list of numbers.
 *
 * @param values - Non-empty list of numbers
 * @returns The middle value, or the mean of the two middle values
 */
function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Lists the positions of the vertical rules that cross a table, without duplicates.
 *
 * @param rules - Vertical rules of the page
 * @param top - Top edge of the table
 * @param bottom - Bottom edge of the table
 * @returns Rule positions from left to right
 */
function rulePositions(rules: readonly PageRule[], top: number, bottom: number): readonly number[] {
  const positions: number[] = [];
  for (const position of rules
    .filter((rule) => rule.start < bottom && rule.end > top)
    .map((rule) => rule.position)
    .toSorted((left, right) => left - right)) {
    if (positions.length === 0 || position - positions.at(-1)! > RULE_MERGE_DISTANCE) {
      positions.push(position);
    }
  }
  return positions;
}

/**
 * Counts the rules left of a position, which numbers the slot between rules that contains it.
 *
 * @param positions - Rule positions from left to right
 * @param x - Normalized horizontal position
 * @returns The zero-based slot index
 */
const slotAt = (positions: readonly number[], x: number): number =>
  positions.filter((position) => position <= x).length;

/**
 * Splits a token at every rule it crosses by a wide enough margin.
 *
 * @remarks
 * Characters, counted as graphemes, are assumed to share the token's width evenly. A token is cut only when each side
 * keeps at least 3 characters and a quarter of the token, so a value overhanging its rule by a
 * letter stays whole.
 *
 * @param token - Token to split
 * @param positions - Rule positions from left to right
 * @returns The token's pieces from left to right, or the token itself
 */
function splitAtRules(token: TextToken, positions: readonly number[]): readonly TextToken[] {
  const characters = Array.from(graphemes.segment(token.text), (item) => item.segment);
  const { x, width } = token.box;
  const minimum = Math.max(SPLIT_MIN_CHARACTERS, Math.ceil(characters.length * SPLIT_MIN_SHARE));
  const cuts: number[] = [];
  for (const position of positions) {
    if (position <= x || position >= x + width) continue;
    const cut = Math.round((characters.length * (position - x)) / width);
    if (cut - (cuts.at(-1) ?? 0) >= minimum && characters.length - cut >= minimum) cuts.push(cut);
  }
  if (cuts.length === 0) return [token];
  return [0, ...cuts].map((start, index) => {
    const end = cuts[index] ?? characters.length;
    return {
      ...token,
      text: characters.slice(start, end).join(""),
      box: {
        ...token.box,
        x: x + (width * start) / characters.length,
        width: (width * (end - start)) / characters.length,
      },
    };
  });
}

/**
 * Lays out the tokens of one page as table rows.
 *
 * @remarks
 * 1. The header is the first visual line where at least `minColumns` labels match, the `rowKey`
 *    column's among them. A column whose label is missing gets no cells.
 * 2. When the page's vertical rules crossing the table put every located label in its own slot,
 *    the slots are the column spans: a token crossing a rule is split first, then goes to the slot
 *    containing its center, and tokens in a slot without a label are ignored. Otherwise column
 *    boundaries sit halfway between adjacent label centers, because values are often wider than
 *    centered labels, and each token goes to the column containing its center.
 * 3. A row starts at every line with a token in the `rowKey` column. Any other line attaches to the
 *    vertically nearest row, which keeps a cell wrapped above its row in that row.
 * 4. With `rowTolerance`, the row pitch is the median distance between the header and successive
 *    row starts. Row starts closer than 0.6 pitch to the previous one are wrapped fragments that
 *    attach like any other line, and lines farther than `rowTolerance` pitches from every row are
 *    dropped rather than merged into the nearest one.
 *
 * @param tokens - Selected tokens of one page, in any order
 * @param columns - Columns with their header labels
 * @param rowKey - Key of the column whose tokens start a new row
 * @param options - Header matching, row tolerance, and rules
 * @returns The rows and what was left out of them, or `undefined` when no header line is found
 */
export function layoutTable(
  tokens: readonly TextToken[],
  columns: readonly TableLayoutColumn[],
  rowKey: string,
  options: TableLayoutOptions,
): TableLayout | undefined {
  const lines = visualLines(tokens);
  let headerIndex = -1;
  let labels: readonly HeaderLabel[] = [];
  for (const [index, line] of lines.entries()) {
    const found = locateLabels(line, columns, options.fuzzy);
    if (found.length >= options.minColumns && found.some((label) => label.key === rowKey)) {
      headerIndex = index;
      labels = found;
      break;
    }
  }
  if (headerIndex < 0) return undefined;

  const header = lines[headerIndex]!;
  const bodyLines = lines.slice(headerIndex + 1);
  const ordered = labels.toSorted((left, right) => left.center - right.center);
  const top = Math.min(...header.map((token) => token.box.y));
  const bottom = Math.max(
    ...[...header, ...bodyLines.flat()].map((token) => token.box.y + token.box.height),
  );
  const positions = rulePositions(options.rules ?? [], top, bottom);
  const slots = ordered.map((label) => slotAt(positions, label.center));
  const ruled = positions.length > 0 && new Set(slots).size === slots.length;
  const bounds = ordered
    .slice(1)
    .map((column, index) => (ordered[index]!.center + column.center) / 2);
  /**
   * Finds the column containing a horizontal position.
   *
   * @param x - Normalized horizontal position
   * @returns The key of the column spanning `x`, or `undefined` for a ruled slot without a label
   */
  const columnAt = (x: number): string | undefined => {
    if (ruled) return ordered[slots.indexOf(slotAt(positions, x))]?.key;
    const index = bounds.findIndex((bound) => x < bound);
    return ordered[index < 0 ? ordered.length - 1 : index]!.key;
  };

  const body = bodyLines.flatMap((line) => {
    const pieces = ruled ? line.flatMap((token) => splitAtRules(token, positions)) : line;
    const cells = pieces.flatMap((token) => {
      const key = columnAt(token.box.x + token.box.width / 2);
      return key === undefined ? [] : [{ key, token }];
    });
    return cells.length === 0 ? [] : [{ center: lineCenter(line), line, cells }];
  });
  const seeds = body.filter((line) => line.cells.some((cell) => cell.key === rowKey));
  const missingColumns = columns
    .filter((column) => !labels.some((label) => label.key === column.key))
    .map((column) => column.key);
  if (seeds.length === 0) return { rows: [], missingColumns, droppedLines: [] };

  const headerCenter = lineCenter(header);
  /**
   * Median distance between the header and successive row starts.
   *
   * @param starts - Row start lines from top to bottom
   * @returns The row pitch
   */
  const pitchOf = (starts: readonly { readonly center: number }[]): number =>
    median(
      starts.map((start, index) => start.center - (starts[index - 1]?.center ?? headerCenter)),
    );
  let starts = seeds;
  if (options.rowTolerance !== undefined) {
    const pitch = pitchOf(seeds);
    starts = seeds.filter(
      (seed, index) =>
        index === 0 || seed.center - seeds[index - 1]!.center >= ROW_MERGE_RATIO * pitch,
    );
  }
  const rows = starts.map((start) => ({
    center: start.center,
    cells: new Map<string, TextToken[]>(),
  }));
  const maxDistance =
    options.rowTolerance === undefined ? Infinity : options.rowTolerance * pitchOf(starts);

  const droppedLines: string[] = [];
  for (const line of body) {
    let nearest = rows[0]!;
    for (const row of rows) {
      if (Math.abs(row.center - line.center) < Math.abs(nearest.center - line.center))
        nearest = row;
    }
    if (Math.abs(nearest.center - line.center) > maxDistance) {
      droppedLines.push(line.line.map((token) => token.text).join(" "));
      continue;
    }
    for (const { key, token } of line.cells) {
      nearest.cells.set(key, [...(nearest.cells.get(key) ?? []), token]);
    }
  }
  return { rows: rows.map((row) => row.cells), missingColumns, droppedLines };
}
