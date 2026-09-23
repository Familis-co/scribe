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

export interface ExtractPage {
  readonly number: number;
  readonly tokens: readonly TextToken[];
}

export interface ProfileExtraction {
  readonly value: Record<string, unknown>;
  readonly evidence: Record<JsonPointer, readonly FieldEvidence[]>;
  readonly diagnostics: readonly Diagnostic[];
  readonly missingRequired: readonly JsonPointer[];
  readonly implicatedPages: readonly number[];
}

interface FieldResult {
  readonly found: boolean;
  readonly value?: unknown;
  readonly evidence: readonly FieldEvidence[];
  readonly pages: readonly number[];
  readonly confidence?: number;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

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

function unionBoxes(boxes: readonly BoundingBox[]): BoundingBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return normalizeBox({ x: left, y: top, width: right - left, height: bottom - top });
}

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

function pageNumbers(page: TextSelector["page"], pages: readonly ExtractPage[]): readonly number[] {
  if (pages.length === 0) return [];
  if (page === "any") return pages.map((item) => item.number);
  if (page === "first") return [pages[0]!.number];
  if (page === "last") return [pages.at(-1)!.number];
  return pages.some((item) => item.number === page) ? [page] : [];
}

function sortedTokens(tokens: readonly TextToken[]): readonly TextToken[] {
  return tokens.toSorted((left, right) => {
    const leftLine = left.lineIndex ?? Math.round(left.box.y * 1_000);
    const rightLine = right.lineIndex ?? Math.round(right.box.y * 1_000);
    return leftLine - rightLine || left.box.x - right.box.x;
  });
}

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

function textFromTokens(tokens: readonly TextToken[]): string {
  return groupLines(tokens)
    .map((line) => line.map((token) => token.text).join(" "))
    .join("\n");
}

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

function comparableText(
  value: string,
  transform: Extract<TransformDefinition, { kind: "closestMatch" }>,
): string {
  let comparable = value.normalize("NFKD");
  if (transform.ignoreDiacritics) comparable = comparable.replace(/\p{M}/gu, "");
  return transform.ignoreCase ? comparable.toLocaleLowerCase() : comparable;
}

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

function transformNames(transforms: readonly TransformDefinition[]): readonly string[] {
  return transforms.map((item) => (item.kind === "custom" ? item.name : item.kind));
}

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

const pointerFor = (segments: readonly string[]): JsonPointer =>
  `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

export async function extractProfile(
  profile: DocumentProfile,
  pages: readonly ExtractPage[],
): Promise<ProfileExtraction> {
  const evidence: Record<JsonPointer, readonly FieldEvidence[]> = {};
  const diagnostics: Diagnostic[] = [];
  const missingRequired: JsonPointer[] = [];
  const implicatedPages = new Set<number>();

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
