import type {
  AfterAnchorSelector,
  AnchorSelector,
  DocumentProfile,
  FieldDefinition,
  FieldTree,
  TextSelector,
  TransformDefinition,
} from "./profile.js";
import { isFieldDefinition } from "./profile.js";
import type { BoundingBox, Diagnostic, FieldEvidence, JsonPointer, TextToken } from "./types.js";

/** Page tokens consumed by {@link extractProfile}. */
export interface ExtractPage {
  /** One-based page number. */
  readonly number: number;
  /** Final positioned tokens for the page, native or OCR. */
  readonly tokens: readonly TextToken[];
}

/** Unvalidated outcome of applying a profile to a set of pages. */
export interface ProfileExtraction {
  /** Raw extracted object, before Standard Schema validation. */
  readonly value: Record<string, unknown>;
  /** Field evidence indexed by JSON Pointer. */
  readonly evidence: Record<JsonPointer, readonly FieldEvidence[]>;
  /** Non-fatal diagnostics produced while resolving fields. */
  readonly diagnostics: readonly Diagnostic[];
  /** Required fields that could not be resolved. */
  readonly missingRequired: readonly JsonPointer[];
  /** Pages where unresolved fields were searched, used to target the OCR fallback. */
  readonly implicatedPages: readonly number[];
}

/** Outcome of resolving a single field definition. */
interface FieldResult {
  readonly found: boolean;
  readonly value?: unknown;
  readonly evidence: readonly FieldEvidence[];
  readonly pages: readonly number[];
  /** Confidence of each captured value, in value order; `undefined` for native-only values. */
  readonly confidences: readonly (number | undefined)[];
}

/** Tokens selected on one page, in reading order. */
interface PageSelection {
  readonly page: number;
  readonly tokens: readonly TextToken[];
}

/** A token's position in text assembled by {@link layoutText}. */
interface TokenSpan {
  /** Offset of the token's first character. */
  readonly start: number;
  /** Offset just past the token's last character. */
  readonly end: number;
  readonly token: TextToken;
  readonly page: number;
}

/** Text assembled from selected tokens, with the character range each token occupies. */
interface TextLayout {
  readonly text: string;
  readonly spans: readonly TokenSpan[];
}

/** A captured raw value and the `[start, end)` range it was read from in the assembled text. */
interface CapturedValue {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Evidence and confidence for one captured value. */
interface ValueReading {
  readonly evidence: readonly FieldEvidence[];
  readonly confidence?: number;
}

/**
 * Clamps a value to the normalized `[0, 1]` range.
 *
 * @param value - Number to clamp
 * @returns The clamped value
 */
const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Clamps a rectangle so it stays entirely inside the normalized page.
 *
 * @param box - Rectangle that may extend beyond the page
 * @returns The rectangle clipped to the page bounds
 */
function normalizeBox(box: BoundingBox): BoundingBox {
  const x = clamp(box.x);
  const y = clamp(box.y);
  return {
    x,
    y,
    width: clamp(Math.min(box.width, 1 - x)),
    height: clamp(Math.min(box.height, 1 - y)),
  };
}

/**
 * Computes the smallest normalized rectangle enclosing every box.
 *
 * @param boxes - Non-empty list of rectangles
 * @returns The enclosing rectangle, clipped to the page bounds
 */
function unionBoxes(boxes: readonly BoundingBox[]): BoundingBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return normalizeBox({ x: left, y: top, width: right - left, height: bottom - top });
}

/**
 * Determines whether a token's center point lies inside a rectangle.
 *
 * @param token - Token to test
 * @param box - Normalized selection rectangle
 * @returns `true` when the token center is inside or on the edge of the rectangle
 */
function tokenCenterInBox(token: TextToken, box: BoundingBox): boolean {
  const centerX = token.box.x + token.box.width / 2;
  const centerY = token.box.y + token.box.height / 2;
  return (
    centerX >= box.x &&
    centerX <= box.x + box.width &&
    centerY >= box.y &&
    centerY <= box.y + box.height
  );
}

/**
 * Resolves a page selector against the available pages.
 *
 * @param page - One-based or symbolic page selector
 * @param pages - Pages available for extraction
 * @returns Matching one-based page numbers, empty when the selector matches nothing
 */
function pageNumbers(page: TextSelector["page"], pages: readonly ExtractPage[]): readonly number[] {
  if (pages.length === 0) return [];
  if (page === "any") return pages.map((item) => item.number);
  if (page === "first") return [pages[0]!.number];
  if (page === "last") return [pages.at(-1)!.number];
  return pages.some((item) => item.number === page) ? [page] : [];
}

/**
 * Orders tokens by line, then from left to right.
 *
 * @remarks
 * Tokens without a `lineIndex` are grouped by their vertical position rounded to a thousandth of the
 * page height.
 *
 * @param tokens - Tokens in any order
 * @returns A new array in reading order
 */
function sortedTokens(tokens: readonly TextToken[]): readonly TextToken[] {
  return tokens.toSorted((left, right) => {
    const leftLine = left.lineIndex ?? Math.round(left.box.y * 1_000);
    const rightLine = right.lineIndex ?? Math.round(right.box.y * 1_000);
    return leftLine - rightLine || left.box.x - right.box.x;
  });
}

/**
 * Groups tokens into lines in reading order.
 *
 * @param tokens - Tokens in any order
 * @returns One array of left-to-right tokens per line
 */
function groupLines(tokens: readonly TextToken[]): readonly (readonly TextToken[])[] {
  const groups = new Map<number, TextToken[]>();
  for (const token of sortedTokens(tokens)) {
    const key = token.lineIndex ?? Math.round(token.box.y * 1_000);
    const line = groups.get(key) ?? [];
    line.push(token);
    groups.set(key, line);
  }
  return [...groups.values()];
}

/**
 * Joins one line's tokens with single spaces.
 *
 * @param line - Tokens of a single line, left to right
 * @returns The line text and the character range of every token in it
 */
function lineText(line: readonly TextToken[]): {
  text: string;
  spans: readonly { start: number; end: number; token: TextToken }[];
} {
  const spans: Array<{ start: number; end: number; token: TextToken }> = [];
  let text = "";
  for (const token of line) {
    if (text.length > 0) text += " ";
    const start = text.length;
    text += token.text;
    spans.push({ start, end: text.length, token });
  }
  return { text, spans };
}

/**
 * Finds the first occurrence of a literal or regular expression in text.
 *
 * @param text - Text to search
 * @param search - Literal text or regular expression, whose `g` flag is ignored
 * @param caseSensitive - Whether literal matching preserves case
 * @returns The `[start, end)` range of the first match, or `undefined` when there is none
 */
function findText(
  text: string,
  search: string | RegExp,
  caseSensitive: boolean,
): { start: number; end: number } | undefined {
  if (typeof search === "string") {
    const haystack = caseSensitive ? text : text.toLocaleLowerCase();
    const start = haystack.indexOf(caseSensitive ? search : search.toLocaleLowerCase());
    return start < 0 ? undefined : { start, end: start + search.length };
  }
  const match = new RegExp(search.source, search.flags.replaceAll("g", "")).exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

/** One line-level occurrence of an anchor. */
interface AnchorMatch {
  /** Union of the tokens covered by the match. */
  readonly box: BoundingBox;
  /** Tokens of the same line to the right of the anchor's last token, left to right. */
  readonly following: readonly TextToken[];
}

/**
 * Finds every line-level occurrence of an anchor's text.
 *
 * @remarks
 * Each line is joined with single spaces so literal and regex anchors can span several tokens. Only
 * the first match per line is reported.
 *
 * @param tokens - Tokens of a single page
 * @param selector - Anchor text and matching options
 * @returns Each match with the tokens that follow it on its line, in reading order
 */
function findAnchors(
  tokens: readonly TextToken[],
  selector: AnchorSelector | AfterAnchorSelector,
): readonly AnchorMatch[] {
  const anchors: AnchorMatch[] = [];
  for (const line of groupLines(tokens)) {
    const { text, spans } = lineText(line);
    const found = findText(text, selector.text, selector.caseSensitive);
    if (!found) continue;
    const matched = spans.filter((span) => span.end > found.start && span.start < found.end);
    if (matched.length === 0) continue;
    anchors.push({
      box: unionBoxes(matched.map((span) => span.token.box)),
      following: line.slice(line.indexOf(matched.at(-1)!.token) + 1),
    });
  }
  return anchors;
}

/**
 * Cuts a line's tokens before the first token where a stop pattern matches.
 *
 * @param tokens - Tokens following an anchor, left to right
 * @param stopAt - Literal or regular-expression stop text, which may span several tokens
 * @param caseSensitive - Whether literal matching preserves case
 * @returns The tokens that end before the stop match, or every token when it does not match
 */
function tokensBefore(
  tokens: readonly TextToken[],
  stopAt: string | RegExp,
  caseSensitive: boolean,
): readonly TextToken[] {
  const { text, spans } = lineText(tokens);
  const found = findText(text, stopAt, caseSensitive);
  if (!found) return tokens;
  return spans.filter((span) => span.end <= found.start).map((span) => span.token);
}

/**
 * Selects the tokens of one page matched by a selector.
 *
 * @param selector - Region, anchor-relative, or line-scoped anchor selector
 * @param tokens - Tokens of a single page
 * @returns The selected tokens in any order, empty when the anchor is not found
 */
function selectOnPage(selector: TextSelector, tokens: readonly TextToken[]): readonly TextToken[] {
  if (selector.kind === "region") {
    return tokens.filter((token) => tokenCenterInBox(token, selector.box));
  }
  const anchor = findAnchors(tokens, selector)[selector.occurrence];
  if (!anchor) return [];
  if (selector.kind === "afterAnchor") {
    return selector.stopAt === undefined
      ? anchor.following
      : tokensBefore(anchor.following, selector.stopAt, selector.caseSensitive);
  }
  const box = normalizeBox({
    x: anchor.box.x + selector.offset.x,
    y: anchor.box.y + selector.offset.y,
    width: selector.offset.width,
    height: selector.offset.height,
  });
  return tokens.filter((token) => tokenCenterInBox(token, box));
}

/**
 * Collects the tokens selected by a selector across eligible pages.
 *
 * @param selector - Region, anchor-relative, or line-scoped anchor selector
 * @param pages - Pages available for extraction
 * @returns Selected tokens grouped by page in reading order, and the pages that contributed at least
 * one token
 */
function tokensForSelector(
  selector: TextSelector,
  pages: readonly ExtractPage[],
): { selections: readonly PageSelection[]; pages: readonly number[] } {
  const candidates = pageNumbers(selector.page, pages);
  const selections: PageSelection[] = [];

  for (const pageNumber of candidates) {
    const page = pages.find((item) => item.number === pageNumber);
    if (!page) continue;
    const tokens = selectOnPage(selector, page.tokens);
    if (tokens.length > 0) selections.push({ page: pageNumber, tokens: sortedTokens(tokens) });
  }

  return { selections, pages: selections.map((selection) => selection.page) };
}

/**
 * Joins selected tokens into text, with spaces between words and newlines between lines and pages.
 *
 * @param selections - Selected tokens grouped by page
 * @returns The reconstructed text and the character range of every token in it
 */
function layoutText(selections: readonly PageSelection[]): TextLayout {
  const spans: TokenSpan[] = [];
  let text = "";
  for (const selection of selections) {
    for (const line of groupLines(selection.tokens)) {
      if (text.length > 0) text += "\n";
      line.forEach((token, index) => {
        if (index > 0) text += " ";
        const start = text.length;
        text += token.text;
        spans.push({ start, end: text.length, token, page: selection.page });
      });
    }
  }
  return { text, spans };
}

/**
 * Reads a capture group's value and its range from a match made with the `d` flag.
 *
 * @param match - Match carrying `indices`
 * @param group - Numeric or named capture group
 * @returns The captured value with its `[start, end)` range, or `undefined` when the group did not
 * participate in the match
 */
function capturedGroup(match: RegExpExecArray, group: number | string): CapturedValue | undefined {
  const value = typeof group === "number" ? match[group] : match.groups?.[group];
  const range = typeof group === "number" ? match.indices?.[group] : match.indices?.groups?.[group];
  if (value === undefined || !range) return undefined;
  return { value, start: range[0], end: range[1] };
}

/**
 * Applies a field's optional capture pattern to selected text.
 *
 * @remarks
 * Without a pattern, scalar fields return the whole text and repeated fields return one value per
 * non-empty line. With a pattern, repeated fields collect the capture group of every match.
 *
 * @param text - Text reconstructed from the selected tokens
 * @param field - Field whose capture and cardinality apply
 * @returns Captured raw values with their ranges in `text`, empty when nothing matched
 */
function captureValues(text: string, field: FieldDefinition): readonly CapturedValue[] {
  if (!field.capture) {
    if (!field.many) return text.trim() ? [{ value: text, start: 0, end: text.length }] : [];
    const values: CapturedValue[] = [];
    let offset = 0;
    for (const line of text.split("\n")) {
      const value = line.trim();
      if (value) {
        const start = offset + line.indexOf(value);
        values.push({ value, start, end: start + value.length });
      }
      offset += line.length + 1;
    }
    return values;
  }

  const { pattern, group } = field.capture;
  const flags = pattern.flags.includes("d") ? pattern.flags : `${pattern.flags}d`;
  if (!field.many) {
    const match = new RegExp(pattern.source, flags.replaceAll("g", "")).exec(text);
    const value = match ? capturedGroup(match, group) : undefined;
    return value ? [value] : [];
  }

  const regex = new RegExp(pattern.source, flags.includes("g") ? flags : `${flags}g`);
  return [...text.matchAll(regex)].flatMap((match) => capturedGroup(match, group) ?? []);
}

/**
 * Lowest OCR confidence among tokens.
 *
 * @remarks
 * The minimum rather than the mean: one uncertain character in an identifier must be enough to flag
 * the whole value.
 *
 * @param tokens - Tokens backing a value
 * @returns The lowest confidence, or `undefined` when no token carries one
 */
function lowestConfidence(tokens: readonly TextToken[]): number | undefined {
  const values = tokens.flatMap((token) =>
    token.confidence === undefined ? [] : [token.confidence],
  );
  return values.length === 0 ? undefined : Math.min(...values);
}

/**
 * Builds the evidence for one captured value from the tokens its range overlaps.
 *
 * @remarks
 * A zero-length capture overlaps no token, so it falls back to every selected token.
 *
 * @param layout - Assembled text and token ranges
 * @param captured - Captured value and its range in the assembled text
 * @param transformations - Names of the field's transformations
 * @returns One evidence entry per page the value spans, and the value's confidence
 */
function readValue(
  layout: TextLayout,
  captured: CapturedValue,
  transformations: readonly string[],
): ValueReading {
  const overlapping = layout.spans.filter(
    (span) => span.end > captured.start && span.start < captured.end,
  );
  const backing = overlapping.length > 0 ? overlapping : layout.spans;
  const evidence = [...new Set(backing.map((span) => span.page))].map((page): FieldEvidence => {
    const spans = backing.filter((span) => span.page === page);
    const tokens = spans.map((span) => span.token);
    const confidence = lowestConfidence(tokens);
    return {
      page,
      box: unionBoxes(tokens.map((token) => token.box)),
      text: layout.text.slice(spans[0]!.start, spans.at(-1)!.end),
      method: tokens.some((token) => token.source === "ocr") ? "ocr" : "native",
      ...(confidence === undefined ? {} : { confidence }),
      transformations,
    };
  });
  const confidence = lowestConfidence(backing.map((span) => span.token));
  return { evidence, ...(confidence === undefined ? {} : { confidence }) };
}

/**
 * Parses a numeric calendar date in the transform's field order.
 *
 * @param value - Date text using any single non-digit separator
 * @param transform - Date transform declaring the expected field order
 * @returns A UTC midnight `Date`
 * @throws `TypeError` when the text is not a numeric date or names a non-existent calendar day
 */
function parseDate(value: string, transform: Extract<TransformDefinition, { kind: "date" }>): Date {
  const parts = value.match(/^(\d{1,4})\D(\d{1,2})\D(\d{1,4})$/u);
  if (!parts) throw new TypeError(`Cannot parse date: ${value}`);
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  const third = Number(parts[3]);
  const [year, month, day] =
    transform.format === "YYYY-MM-DD"
      ? [first, second, third]
      : transform.format === "DD/MM/YYYY"
        ? [third, second, first]
        : [third, first, second];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError(`Invalid calendar date: ${value}`);
  }
  return date;
}

/**
 * Normalizes text for fuzzy comparison according to a closest-match transform.
 *
 * @param value - Text to normalize
 * @param transform - Closest-match transform carrying the case and diacritic options
 * @returns NFKD-normalized text, optionally lowercased and stripped of combining marks
 */
function comparableText(
  value: string,
  transform: Extract<TransformDefinition, { kind: "closestMatch" }>,
): string {
  let comparable = value.normalize("NFKD");
  if (transform.ignoreDiacritics) comparable = comparable.replace(/\p{M}/gu, "");
  return transform.ignoreCase ? comparable.toLocaleLowerCase() : comparable;
}

/**
 * Computes the Levenshtein distance between two strings.
 *
 * @param left - First string
 * @param right - Second string
 * @returns Minimum number of single-character insertions, deletions, or substitutions
 */
function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * Replaces a value with its uniquely closest candidate.
 *
 * @param value - Captured text
 * @param transform - Closest-match transform with candidates and a maximum distance
 * @returns The closest candidate, or the original value when the best match is tied or too distant
 */
function closestMatch(
  value: string,
  transform: Extract<TransformDefinition, { kind: "closestMatch" }>,
): string {
  const comparable = comparableText(value, transform);
  let best: { candidate: string; distance: number } | undefined;
  let tied = false;

  for (const candidate of transform.candidates) {
    const distance = editDistance(comparable, comparableText(candidate, transform));
    if (!best || distance < best.distance) {
      best = { candidate, distance };
      tied = false;
    } else if (distance === best.distance) {
      tied = true;
    }
  }

  return best && !tied && best.distance <= transform.maxDistance ? best.candidate : value;
}

/**
 * Applies transformations to a captured value in declaration order.
 *
 * @param initial - Raw captured value
 * @param transforms - Ordered transformations to apply
 * @returns The transformed value
 * @throws `TypeError` when a built-in transform receives a non-string value or cannot parse it
 */
async function applyTransforms(
  initial: unknown,
  transforms: readonly TransformDefinition[],
): Promise<unknown> {
  let value = initial;
  for (const current of transforms) {
    if (current.kind === "custom") {
      value = await current.map(value);
      continue;
    }
    if (typeof value !== "string") {
      throw new TypeError(`${current.kind} expects a string value.`);
    }
    switch (current.kind) {
      case "trim":
        value = value.trim();
        break;
      case "normalizeWhitespace":
        value = value.replace(/\s+/gu, " ").trim();
        break;
      case "replace":
        value = value.replace(current.search, current.replacement);
        break;
      case "number": {
        let normalized = value;
        for (const separator of current.groupSeparators) {
          if (separator !== current.decimalSeparator)
            normalized = normalized.replaceAll(separator, "");
        }
        normalized = normalized.replace(current.decimalSeparator, ".");
        const number = Number(normalized);
        if (!Number.isFinite(number)) throw new TypeError(`Cannot parse number: ${value}`);
        value = number;
        break;
      }
      case "date": {
        const date = parseDate(value, current);
        value = current.output === "date" ? date : date.toISOString().slice(0, 10);
        break;
      }
      case "closestMatch":
        value = closestMatch(value, current);
        break;
    }
  }
  return value;
}

/**
 * Lists the names recorded in field evidence for a set of transformations.
 *
 * @param transforms - Ordered transformations
 * @returns Built-in kinds, or the declared name for custom transforms
 */
function transformNames(transforms: readonly TransformDefinition[]): readonly string[] {
  return transforms.map((item) => (item.kind === "custom" ? item.name : item.kind));
}

/**
 * Resolves one field definition against the extraction pages.
 *
 * @param field - Field to resolve
 * @param pages - Pages available for extraction
 * @returns The transformed value with its evidence, or `found: false` with the searched pages
 * @throws `TypeError` when a transformation rejects the captured value
 */
async function extractField(
  field: FieldDefinition,
  pages: readonly ExtractPage[],
): Promise<FieldResult> {
  const selected = tokensForSelector(field.selector, pages);
  const layout = layoutText(selected.selections);
  const captured = captureValues(layout.text, field);

  if (captured.length === 0) {
    if (Object.hasOwn(field, "defaultValue")) {
      return {
        found: true,
        value: field.defaultValue,
        evidence: [],
        pages: selected.pages,
        confidences: [],
      };
    }
    return {
      found: false,
      evidence: [],
      pages: pageNumbers(field.selector.page, pages),
      confidences: [],
    };
  }

  const transformed = await Promise.all(
    captured.map((item) => applyTransforms(item.value, field.transforms)),
  );
  const names = transformNames(field.transforms);
  const readings = captured.map((item) => readValue(layout, item, names));

  return {
    found: true,
    value: field.many ? transformed : transformed[0],
    evidence: readings.flatMap((reading) => reading.evidence),
    pages: selected.pages,
    confidences: readings.map((reading) => reading.confidence),
  };
}

/**
 * Builds an RFC 6901 JSON Pointer from object keys.
 *
 * @param segments - Unescaped object keys from the root
 * @returns The escaped JSON Pointer
 */
const pointerFor = (segments: readonly string[]): JsonPointer =>
  `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

/**
 * Resolves every field of a profile against page tokens.
 *
 * @remarks
 * Missing fields and failing transformations are reported through diagnostics and
 * `missingRequired` rather than thrown, so the caller can decide whether to retry with OCR.
 *
 * @param profile - Profile whose field tree is resolved
 * @param pages - Page tokens to extract from
 * @returns The raw extracted value, evidence, diagnostics, and unresolved required fields
 */
export async function extractProfile(
  profile: DocumentProfile,
  pages: readonly ExtractPage[],
): Promise<ProfileExtraction> {
  const evidence: Record<JsonPointer, readonly FieldEvidence[]> = {};
  const diagnostics: Diagnostic[] = [];
  const missingRequired: JsonPointer[] = [];
  const implicatedPages = new Set<number>();

  /**
   * Recursively resolves a field-tree node.
   *
   * @param tree - Field definition or nested object of fields
   * @param path - Object keys leading to this node
   * @returns The resolved value, or `undefined` when a leaf could not be resolved
   */
  const visit = async (tree: FieldTree, path: readonly string[]): Promise<unknown> => {
    if (isFieldDefinition(tree)) {
      const pointer = pointerFor(path);
      try {
        const result = await extractField(tree, pages);
        if (!result.found) {
          if (tree.required) missingRequired.push(pointer);
          result.pages.forEach((page) => implicatedPages.add(page));
          diagnostics.push({
            level: tree.required ? "warning" : "info",
            code: "FIELD_NOT_FOUND",
            message: `No value was found for ${pointer}.`,
            path: pointer,
          });
          return undefined;
        }
        if (result.evidence.length > 0) evidence[pointer] = result.evidence;
        const threshold = tree.warnBelowConfidence;
        result.confidences.forEach((confidence, index) => {
          if (threshold === undefined || confidence === undefined || confidence >= threshold)
            return;
          const valuePointer = tree.many ? pointerFor([...path, String(index)]) : pointer;
          diagnostics.push({
            level: "warning",
            code: "LOW_FIELD_CONFIDENCE",
            message: `OCR confidence for ${valuePointer} is ${confidence.toFixed(3)}, below ${threshold.toFixed(3)}.`,
            path: valuePointer,
          });
        });
        return result.value;
      } catch (cause) {
        if (tree.required) missingRequired.push(pointer);
        diagnostics.push({
          level: "warning",
          code: "TRANSFORM_FAILED",
          message: cause instanceof Error ? cause.message : `A transform failed for ${pointer}.`,
          path: pointer,
        });
        return undefined;
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(tree)) {
      const value = await visit(child, [...path, key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  };

  const visited = await visit(profile.fields, []);
  const value =
    typeof visited === "object" && visited !== null
      ? Object.fromEntries(Object.entries(visited))
      : {};
  return {
    value,
    evidence,
    diagnostics,
    missingRequired,
    implicatedPages: [...implicatedPages],
  };
}
