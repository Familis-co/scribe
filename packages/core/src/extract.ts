import type {
  AnchorSelector,
  DocumentProfile,
  FieldDefinition,
  FieldTree,
  TextSelector,
  TransformDefinition,
} from "./profile.js";
import { isFieldDefinition } from "./profile.js";
import type {
  BoundingBox,
  Diagnostic,
  FieldEvidence,
  JsonPointer,
  TextSource,
  TextToken,
} from "./types.js";

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
 * Finds every line-level occurrence of an anchor's text.
 *
 * @remarks
 * Each line is joined with single spaces so literal and regex anchors can span several tokens. Only
 * the first match per line is reported.
 *
 * @param tokens - Tokens of a single page
 * @param selector - Anchor text and matching options
 * @returns Bounding boxes of the tokens covered by each match, in reading order
 */
function findAnchors(
  tokens: readonly TextToken[],
  selector: AnchorSelector,
): readonly BoundingBox[] {
  const anchors: BoundingBox[] = [];
  for (const lineTokens of groupLines(tokens)) {
    const spans: Array<{ start: number; end: number; token: TextToken }> = [];
    let text = "";
    for (const token of lineTokens) {
      if (text.length > 0) text += " ";
      const start = text.length;
      text += token.text;
      spans.push({ start, end: text.length, token });
    }

    let start = -1;
    let end = -1;
    if (typeof selector.text === "string") {
      const haystack = selector.caseSensitive ? text : text.toLocaleLowerCase();
      const needle = selector.caseSensitive ? selector.text : selector.text.toLocaleLowerCase();
      start = haystack.indexOf(needle);
      end = start < 0 ? -1 : start + needle.length;
    } else {
      const flags = selector.text.flags.replaceAll("g", "");
      const match = new RegExp(selector.text.source, flags).exec(text);
      if (match) {
        start = match.index;
        end = start + match[0].length;
      }
    }

    if (start >= 0) {
      const matched = spans.filter((span) => span.end > start && span.start < end);
      if (matched.length > 0) anchors.push(unionBoxes(matched.map((span) => span.token.box)));
    }
  }
  return anchors;
}

/**
 * Collects the tokens selected by a region or anchor selector across eligible pages.
 *
 * @param selector - Region or anchor-relative selector
 * @param pages - Pages available for extraction
 * @returns Selected tokens in reading order and the pages that contributed at least one token
 */
function tokensForSelector(
  selector: TextSelector,
  pages: readonly ExtractPage[],
): { tokens: readonly TextToken[]; pages: readonly number[] } {
  const candidates = pageNumbers(selector.page, pages);
  const selected: TextToken[] = [];
  const selectedPages = new Set<number>();

  for (const pageNumber of candidates) {
    const page = pages.find((item) => item.number === pageNumber);
    if (!page) continue;

    if (selector.kind === "region") {
      const tokens = page.tokens.filter((token) => tokenCenterInBox(token, selector.box));
      if (tokens.length > 0) selectedPages.add(pageNumber);
      selected.push(...tokens);
      continue;
    }

    const anchors = findAnchors(page.tokens, selector);
    const anchor = anchors[selector.occurrence];
    if (!anchor) continue;
    const box = normalizeBox({
      x: anchor.x + selector.offset.x,
      y: anchor.y + selector.offset.y,
      width: selector.offset.width,
      height: selector.offset.height,
    });
    const tokens = page.tokens.filter((token) => tokenCenterInBox(token, box));
    if (tokens.length > 0) selectedPages.add(pageNumber);
    selected.push(...tokens);
  }

  return { tokens: sortedTokens(selected), pages: [...selectedPages] };
}

/**
 * Joins tokens into text, with spaces between words and newlines between lines.
 *
 * @param tokens - Tokens to join
 * @returns The reconstructed text
 */
function textFromTokens(tokens: readonly TextToken[]): string {
  return groupLines(tokens)
    .map((line) => line.map((token) => token.text).join(" "))
    .join("\n");
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
 * @returns Captured raw values, empty when nothing matched
 */
function captureValues(text: string, field: FieldDefinition): readonly string[] {
  if (!field.capture) {
    return field.many
      ? text
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
      : text.trim()
        ? [text]
        : [];
  }

  const { pattern, group } = field.capture;
  if (!field.many) {
    const flags = pattern.flags.replaceAll("g", "");
    const match = new RegExp(pattern.source, flags).exec(text);
    if (!match) return [];
    const value = typeof group === "number" ? match[group] : match.groups?.[group];
    return value === undefined ? [] : [value];
  }

  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const values: string[] = [];
  for (const match of text.matchAll(regex)) {
    const value = typeof group === "number" ? match[group] : match.groups?.[group];
    if (value !== undefined) values.push(value);
  }
  return values;
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
  const text = textFromTokens(selected.tokens);
  const captured = captureValues(text, field);

  if (captured.length === 0) {
    if (Object.hasOwn(field, "defaultValue")) {
      return { found: true, value: field.defaultValue, evidence: [], pages: selected.pages };
    }
    return {
      found: false,
      evidence: [],
      pages: pageNumbers(field.selector.page, pages),
    };
  }

  const transformed = await Promise.all(
    captured.map((value) => applyTransforms(value, field.transforms)),
  );
  const box = unionBoxes(selected.tokens.map((token) => token.box));
  const confidenceValues = selected.tokens.flatMap((token) =>
    token.confidence === undefined ? [] : [token.confidence],
  );
  const confidence =
    confidenceValues.length === 0
      ? undefined
      : confidenceValues.reduce((sum, item) => sum + item, 0) / confidenceValues.length;
  const source: TextSource = selected.tokens.some((token) => token.source === "ocr")
    ? "ocr"
    : "native";

  const evidence = selected.pages.map((page) => ({
    page,
    box,
    text,
    method: source,
    ...(confidence === undefined ? {} : { confidence }),
    transformations: transformNames(field.transforms),
  }));

  return {
    found: true,
    value: field.many ? transformed : transformed[0],
    evidence,
    pages: selected.pages,
    ...(confidence === undefined ? {} : { confidence }),
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
        if (
          tree.warnBelowConfidence !== undefined &&
          result.confidence !== undefined &&
          result.confidence < tree.warnBelowConfidence
        ) {
          diagnostics.push({
            level: "warning",
            code: "LOW_FIELD_CONFIDENCE",
            message: `OCR confidence for ${pointer} is ${result.confidence.toFixed(3)}, below ${tree.warnBelowConfidence.toFixed(3)}.`,
            path: pointer,
          });
        }
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
