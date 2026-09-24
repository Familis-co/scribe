import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { BoundingBox } from "./types.js";

/** One-based page number or a symbolic page selection. */
export type PageSelector = number | "first" | "last" | "any";

/** Selects tokens whose centers fall inside a fixed normalized rectangle. */
export interface RegionSelector {
  /** Selector discriminator. */
  readonly kind: "region";
  /** Pages eligible for selection. */
  readonly page: PageSelector;
  /** Normalized selection rectangle. */
  readonly box: BoundingBox;
}

/** Selects a normalized rectangle relative to a matching text anchor. */
export interface AnchorSelector {
  /** Selector discriminator. */
  readonly kind: "anchor";
  /** Pages eligible for anchor matching. */
  readonly page: PageSelector;
  /** Literal or regular-expression anchor. */
  readonly text: string | RegExp;
  /** Rectangle offset from the anchor's top-left position. */
  readonly offset: BoundingBox;
  /** Zero-based matching anchor occurrence. */
  readonly occurrence: number;
  /** Whether literal anchor matching preserves case. */
  readonly caseSensitive: boolean;
  /** Minimum similarity for a fuzzy literal anchor match. Omitted, literals match exactly. */
  readonly fuzzy?: number;
}

/** Selects the tokens following a text anchor on the same visual line. */
export interface AfterAnchorSelector {
  /** Selector discriminator. */
  readonly kind: "afterAnchor";
  /** Pages eligible for anchor matching. */
  readonly page: PageSelector;
  /** Literal or regular-expression anchor. */
  readonly text: string | RegExp;
  /** Literal or regular-expression text before which the selection stops. */
  readonly stopAt?: string | RegExp;
  /** Zero-based matching anchor occurrence. */
  readonly occurrence: number;
  /** Whether literal anchor and `stopAt` matching preserves case. */
  readonly caseSensitive: boolean;
  /** Minimum similarity for fuzzy literal anchor and `stopAt` matches. Omitted, literals match exactly. */
  readonly fuzzy?: number;
}

/** Selects the visual lines below a text anchor, within the anchor's column. */
export interface BelowAnchorSelector {
  /** Selector discriminator. */
  readonly kind: "belowAnchor";
  /** Pages eligible for anchor matching. */
  readonly page: PageSelector;
  /** Literal or regular-expression anchor. */
  readonly text: string | RegExp;
  /** Zero-based matching anchor occurrence. */
  readonly occurrence: number;
  /** Whether literal anchor matching preserves case. */
  readonly caseSensitive: boolean;
  /** Minimum similarity for a fuzzy literal anchor match. Omitted, literals match exactly. */
  readonly fuzzy?: number;
  /** Number of lines selected below the anchor. */
  readonly maxLines: number;
  /**
   * Largest vertical gap, normalized to the page height, between the anchor and the first line and
   * between consecutive lines. Omitted, twice the anchor's height.
   */
  readonly maxDistance?: number;
}

/** Selector supported by declarative fields. */
export type TextSelector =
  | RegionSelector
  | AnchorSelector
  | AfterAnchorSelector
  | BelowAnchorSelector;

/** Declarative transformation applied after regex capture. */
export type TransformDefinition =
  | { readonly kind: "trim" }
  | { readonly kind: "normalizeWhitespace" }
  | { readonly kind: "replace"; readonly search: string | RegExp; readonly replacement: string }
  | {
      readonly kind: "number";
      readonly decimalSeparator: string;
      readonly groupSeparators: readonly string[];
    }
  | {
      readonly kind: "date";
      readonly format: "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
      readonly output: "iso" | "date";
    }
  | {
      readonly kind: "closestMatch";
      readonly candidates: readonly string[];
      readonly maxDistance: number;
      readonly ignoreCase: boolean;
      readonly ignoreDiacritics: boolean;
    }
  | {
      readonly kind: "custom";
      readonly name: string;
      readonly map: (value: unknown) => unknown;
    };

/** Regular-expression capture used to isolate one or more values. */
export interface CaptureDefinition {
  /** Pattern applied to the selected text. */
  readonly pattern: RegExp;
  /** Numeric or named capture group returned as the field value. */
  readonly group: number | string;
}

/** Fully normalized field definition produced by {@link field}. */
export interface FieldDefinition {
  /** Internal field discriminator. */
  readonly _tag: "Field";
  /** Token selector used by this field. */
  readonly selector: TextSelector;
  /** Optional regex capture. */
  readonly capture?: CaptureDefinition;
  /** Ordered transformations. */
  readonly transforms: readonly TransformDefinition[];
  /** Whether failure to resolve the field makes extraction fail. */
  readonly required: boolean;
  /** Whether repeated captures are returned as an array. */
  readonly many: boolean;
  /** OCR confidence threshold that emits a diagnostic without discarding the value. */
  readonly warnBelowConfidence?: number;
  /** Value used when no capture is found. */
  readonly defaultValue?: unknown;
}

/** Ordered fallback between field definitions, produced by {@link field.firstOf}. */
export interface FirstOfDefinition {
  /** Internal field discriminator. */
  readonly _tag: "FirstOf";
  /** Strategies tried in order. Their own `required`, `defaultValue` and `warnBelowConfidence` are ignored. */
  readonly alternatives: readonly FieldDefinition[];
  /** Whether failure of every alternative makes extraction fail. */
  readonly required: boolean;
  /** OCR confidence threshold applied to the winning alternative's value. */
  readonly warnBelowConfidence?: number;
  /** Value used when every alternative fails. */
  readonly defaultValue?: unknown;
}

/** Normalized table column produced by {@link field.table}. */
export interface TableColumnDefinition {
  /** Output key of the column. */
  readonly key: string;
  /** Header label: a literal compared case-insensitively with whole tokens, or a pattern. */
  readonly label: string | RegExp;
  /** Transformations applied to each cell of the column. */
  readonly transforms: readonly TransformDefinition[];
  /** Whether a row without a value in this column is dropped. */
  readonly required: boolean;
}

/** Table field produced by {@link field.table}, extracted as rows of typed columns. */
export interface TableDefinition {
  /** Internal field discriminator. */
  readonly _tag: "Table";
  /** Selector bounding the table, header included. */
  readonly selector: TextSelector;
  /** Columns in output order. */
  readonly columns: readonly TableColumnDefinition[];
  /** Key of the column whose tokens start a new row. */
  readonly rowKey: string;
  /** Minimum similarity for fuzzy literal header labels. Omitted, labels match exactly. */
  readonly fuzzy?: number;
  /** Labels that must match for a line to be the header: all of them, half of them, or a count. */
  readonly minColumns: "all" | "half" | number;
  /** Largest distance between a body line and its row, as a fraction of the median row pitch. */
  readonly rowTolerance?: number;
  /** Whether vertical rules drawn on the page define the column spans when the adapter reads them. */
  readonly useRules: boolean;
  /** Predicate keeping rows after cell transforms. */
  readonly filter?: (row: Readonly<Record<string, unknown>>) => boolean;
  /** Whether a missing table header makes extraction fail. */
  readonly required: boolean;
  /** OCR confidence threshold applied to every cell. */
  readonly warnBelowConfidence?: number;
  /** Value used when no table header is found. */
  readonly defaultValue?: unknown;
}

/** Recursive object tree whose leaves are field definitions. */
export type FieldTree =
  | FieldDefinition
  | FirstOfDefinition
  | TableDefinition
  | { readonly [key: string]: FieldTree };

/** A page area that may be sent to the OCR engine. */
export interface OcrRegion {
  /** Page the region belongs to. `"any"` declares it on every page. */
  readonly page: PageSelector;
  /** Normalized rectangle with a top-left origin. */
  readonly box: BoundingBox;
}

/** OCR options declared by a profile. */
export interface ProfileOcrOptions {
  /**
   * The only page areas ever sent to the OCR engine.
   *
   * @remarks
   * When set, OCR crops these regions out of the page render and merges the recognized tokens with
   * the native text layer instead of replacing it. Pages without a region are never OCR'd.
   */
  readonly regions?: readonly OcrRegion[];
}

/** Native text of a document, passed to {@link ProfileIdentify.test}. */
export interface IdentifyContext {
  /** Text of every page, joined by newlines. */
  readonly text: string;
  /** Text of each page: tokens joined by spaces and visual lines by newlines. */
  readonly pages: readonly string[];
  /** Number of pages in the document. */
  readonly pageCount: number;
}

/**
 * Rules telling whether a document is the kind a profile describes, checked against the native text
 * layer before any rendering or OCR.
 */
export interface ProfileIdentify {
  /** Literals or patterns that must all be found in the native text. */
  readonly text?: readonly (string | RegExp)[];
  /** Whether literal `text` entries preserve case. Patterns carry their own flags. @defaultValue `false` */
  readonly caseSensitive?: boolean;
  /** Extra predicate, run once every `text` entry is found. */
  readonly test?: (context: IdentifyContext) => boolean | Promise<boolean>;
}

/**
 * Declarative extraction profile coupled to a Standard Schema output validator.
 *
 * @typeParam S - Standard Schema type used to infer the validated output
 */
export interface DocumentProfile<S extends StandardSchemaV1 = StandardSchemaV1> {
  /** Stable profile identifier. */
  readonly id: string;
  /** Application-controlled profile version. */
  readonly version: string;
  /** Explicit OCR languages required by the document format. */
  readonly languages: readonly string[];
  /** Standard Schema validator for the final extracted object. */
  readonly schema: S;
  /** Field tree matching the intended result structure. */
  readonly fields: FieldTree;
  /** OCR options. Without `regions`, OCR recognizes and replaces whole pages. */
  readonly ocr?: ProfileOcrOptions;
  /**
   * Rules identifying the document type from its native text. A document failing them is rejected
   * with `ProfileMismatchError` before any rendering or OCR, and `Scribe.identify` uses them to
   * pick a profile.
   */
  readonly identify?: ProfileIdentify;
}

/** Options shared by scalar and repeated field builders. */
export interface FieldOptions {
  /** Region or anchor-relative selector. */
  readonly select: TextSelector;
  /** Optional pattern used to capture values from selected text. */
  readonly pattern?: RegExp;
  /** Numeric or named regex group. @defaultValue `0` */
  readonly group?: number | string;
  /** Ordered post-capture transformations. */
  readonly transforms?: readonly TransformDefinition[];
  /** Whether the field must be resolved. @defaultValue `true` */
  readonly required?: boolean;
  /** Emit a diagnostic when the lowest OCR confidence behind a captured value is below this value. */
  readonly warnBelowConfidence?: number;
  /** Value returned when selection or capture produces no value. */
  readonly defaultValue?: unknown;
}

/** Options of the {@link field.firstOf} wrapper. */
export interface FirstOfOptions {
  /** Whether one alternative must resolve. @defaultValue `true` */
  readonly required?: boolean;
  /** Emit a diagnostic when the lowest OCR confidence behind the winning value is below this value. */
  readonly warnBelowConfidence?: number;
  /** Value returned when every alternative fails. */
  readonly defaultValue?: unknown;
}

/** One column of a {@link field.table}. */
export interface TableColumnOptions {
  /** Output key of the column. */
  readonly key: string;
  /** Header label: a literal compared case-insensitively with whole tokens, or a pattern. */
  readonly label: string | RegExp;
  /** Transformations applied to each cell of the column. */
  readonly transforms?: readonly TransformDefinition[];
  /** Whether a row without a value in this column is dropped. @defaultValue `true` */
  readonly required?: boolean;
}

/** Options of {@link field.table}. */
export interface TableOptions {
  /** Selector bounding the table, header included. */
  readonly select: TextSelector;
  /** Columns in output order. */
  readonly columns: readonly TableColumnOptions[];
  /** Key of the column whose tokens start a new row. */
  readonly rowKey: string;
  /**
   * Minimum similarity, above `0` and at most `1`, for a literal header label that has no exact
   * match. Omitted, labels match exactly.
   */
  readonly fuzzy?: number;
  /**
   * Labels that must match for a line to be the header: `"all"`, `"half"` (rounded up), or a count.
   * The `rowKey` column's label must always match. @defaultValue `"all"`
   */
  readonly minColumns?: "all" | "half" | number;
  /**
   * Largest distance between a body line and its row, as a fraction of the median row pitch. Lines
   * farther from every row are dropped rather than merged into the nearest one. Omitted, every line
   * joins its nearest row.
   */
  readonly rowTolerance?: number;
  /**
   * Whether vertical rules drawn on the page define the column spans, when the PDF adapter reads
   * rules and they separate every located header. @defaultValue `true`
   */
  readonly useRules?: boolean;
  /** Predicate keeping rows after cell transforms. */
  readonly filter?: (row: Readonly<Record<string, unknown>>) => boolean;
  /** Whether the table header must be found. @defaultValue `true` */
  readonly required?: boolean;
  /** Emit a diagnostic when the lowest OCR confidence behind a cell is below this value. */
  readonly warnBelowConfidence?: number;
  /** Value returned when no table header is found. */
  readonly defaultValue?: unknown;
}

/**
 * Validates an optional confidence threshold.
 *
 * @param threshold - Threshold to validate
 * @throws `RangeError` when the threshold is outside `[0, 1]`
 */
function assertConfidenceThreshold(threshold: number | undefined): void {
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new RangeError("warnBelowConfidence must be between 0 and 1.");
  }
}

/**
 * Validates an optional fuzzy anchor threshold.
 *
 * @param fuzzy - Minimum similarity to validate
 * @returns The threshold as a spreadable property, empty when omitted
 * @throws `RangeError` when the threshold is outside `(0, 1]`
 */
function fuzzyOption(fuzzy: number | undefined): { readonly fuzzy?: number } {
  if (fuzzy === undefined) return {};
  if (!Number.isFinite(fuzzy) || fuzzy <= 0 || fuzzy > 1) {
    throw new RangeError("fuzzy must be greater than 0 and at most 1.");
  }
  return { fuzzy };
}

/**
 * Validates builder options and produces a normalized field definition.
 *
 * @param options - Selection, capture, transformation, and requirement options
 * @param many - Whether repeated captures are returned as an array
 * @returns A normalized field definition
 * @throws `RangeError` when `warnBelowConfidence` is outside `[0, 1]`
 */
function makeField(options: FieldOptions, many: boolean): FieldDefinition {
  assertConfidenceThreshold(options.warnBelowConfidence);
  const capture = options.pattern
    ? { pattern: options.pattern, group: options.group ?? 0 }
    : undefined;
  return {
    _tag: "Field",
    selector: options.select,
    ...(capture ? { capture } : {}),
    transforms: options.transforms ?? [],
    required: options.required ?? true,
    many,
    ...(options.warnBelowConfidence === undefined
      ? {}
      : { warnBelowConfidence: options.warnBelowConfidence }),
    ...(Object.hasOwn(options, "defaultValue") ? { defaultValue: options.defaultValue } : {}),
  };
}

/** Builders for scalar and repeated profile fields. */
export const field = {
  /**
   * Creates a scalar field definition.
   *
   * @param options - Selection, capture, transformation, and requirement options
   * @returns A scalar field definition
   */
  text(options: FieldOptions): FieldDefinition {
    return makeField(options, false);
  },
  /**
   * Creates a repeated field definition.
   *
   * @param options - Selection, repeated capture, transformation, and requirement options
   * @returns A list field definition
   */
  list(options: FieldOptions): FieldDefinition {
    return makeField(options, true);
  },
  /**
   * Creates an ordered fallback between extraction strategies.
   *
   * @remarks
   * Alternatives are tried in order. The first one that captures a value and whose transforms all
   * succeed wins, so a throwing transform rejects a reading and moves on to the next alternative.
   *
   * @param alternatives - Field definitions tried in order
   * @param options - Requirement, default, and confidence options for the whole field
   * @returns A fallback field definition
   *
   * @throws `TypeError` when no alternative is given
   * @throws `RangeError` when `warnBelowConfidence` is outside `[0, 1]`
   */
  firstOf(
    alternatives: readonly FieldDefinition[],
    options: FirstOfOptions = {},
  ): FirstOfDefinition {
    if (alternatives.length === 0) {
      throw new TypeError("firstOf requires at least one alternative.");
    }
    assertConfidenceThreshold(options.warnBelowConfidence);
    return {
      _tag: "FirstOf",
      alternatives: [...alternatives],
      required: options.required ?? true,
      ...(options.warnBelowConfidence === undefined
        ? {}
        : { warnBelowConfidence: options.warnBelowConfidence }),
      ...(Object.hasOwn(options, "defaultValue") ? { defaultValue: options.defaultValue } : {}),
    };
  },
  /**
   * Creates a table field extracted as an array of rows keyed by column.
   *
   * @remarks
   * The header is the first line where `minColumns` column labels match, and column boundaries sit
   * halfway between adjacent label centers, or on the page's vertical rules when they separate every
   * header. A row starts at every line with a token in the `rowKey` column; other lines join the
   * vertically nearest row, within `rowTolerance` when it is set. A failing cell transform sets the
   * cell to `null`, and a row missing a required cell is dropped. Both emit a diagnostic.
   *
   * @param options - Selection, columns, row key, header, row, filter, and requirement options
   * @returns A table field definition
   *
   * @throws `TypeError` when no column is given, a key is repeated, or `rowKey` names no column
   * @throws `RangeError` when `warnBelowConfidence` is outside `[0, 1]`, `fuzzy` is not above `0`
   * and at most `1`, `minColumns` is not a count from 1 to the number of columns, or `rowTolerance`
   * is not positive
   */
  table(options: TableOptions): TableDefinition {
    const keys = options.columns.map((column) => column.key);
    if (keys.length === 0) throw new TypeError("A table requires at least one column.");
    if (new Set(keys).size !== keys.length)
      throw new TypeError("Table column keys must be unique.");
    if (!keys.includes(options.rowKey)) {
      throw new TypeError(`rowKey "${options.rowKey}" does not name a table column.`);
    }
    assertConfidenceThreshold(options.warnBelowConfidence);
    const minColumns = options.minColumns ?? "all";
    if (
      typeof minColumns === "number" &&
      (!Number.isInteger(minColumns) || minColumns < 1 || minColumns > keys.length)
    ) {
      throw new RangeError("minColumns must be a count from 1 to the number of columns.");
    }
    if (
      options.rowTolerance !== undefined &&
      (!Number.isFinite(options.rowTolerance) || options.rowTolerance <= 0)
    ) {
      throw new RangeError("rowTolerance must be a positive number.");
    }
    return {
      _tag: "Table",
      selector: options.select,
      columns: options.columns.map((column) => ({
        key: column.key,
        label: column.label,
        transforms: column.transforms ?? [],
        required: column.required ?? true,
      })),
      rowKey: options.rowKey,
      ...fuzzyOption(options.fuzzy),
      minColumns,
      ...(options.rowTolerance === undefined ? {} : { rowTolerance: options.rowTolerance }),
      useRules: options.useRules ?? true,
      ...(options.filter ? { filter: options.filter } : {}),
      required: options.required ?? true,
      ...(options.warnBelowConfidence === undefined
        ? {}
        : { warnBelowConfidence: options.warnBelowConfidence }),
      ...(Object.hasOwn(options, "defaultValue") ? { defaultValue: options.defaultValue } : {}),
    };
  },
};

/** Builders for fixed and anchor-relative text selectors. */
export const select = {
  /**
   * Selects tokens inside a fixed normalized rectangle.
   *
   * @param box - Normalized rectangle with a top-left origin
   * @param page - One-based or symbolic page selector
   * @returns A fixed-region selector
   */
  region(box: BoundingBox, page: PageSelector = "any"): RegionSelector {
    return { kind: "region", box, page };
  },
  /**
   * Selects a rectangle relative to a text anchor.
   *
   * @param options - Anchor matching and offset options
   * @returns An anchor-relative selector
   *
   * @throws `RangeError` when `fuzzy` is not above `0` and at most `1`
   */
  relativeToAnchor(options: {
    /** Literal or regular-expression anchor, matched line by line. */
    readonly text: string | RegExp;
    /** Rectangle offset from the anchor's top-left position. */
    readonly offset: BoundingBox;
    /** Pages eligible for anchor matching. @defaultValue `"any"` */
    readonly page?: PageSelector;
    /** Zero-based matching anchor occurrence. @defaultValue `0` */
    readonly occurrence?: number;
    /** Whether literal anchor matching preserves case. @defaultValue `false` */
    readonly caseSensitive?: boolean;
    /** Minimum similarity, above `0` and at most `1`, for a fuzzy literal anchor match. */
    readonly fuzzy?: number;
  }): AnchorSelector {
    return {
      kind: "anchor",
      text: options.text,
      offset: options.offset,
      page: options.page ?? "any",
      occurrence: options.occurrence ?? 0,
      caseSensitive: options.caseSensitive ?? false,
      ...fuzzyOption(options.fuzzy),
    };
  },
  /**
   * Selects the tokens to the right of a text anchor on the same visual line.
   *
   * @remarks
   * Unlike {@link select.relativeToAnchor}, the selection follows the anchor's line rather than a
   * fixed box, so it never catches the next line when OCR boxes shift vertically.
   *
   * @param options - Anchor matching and stop options
   * @returns A line-scoped anchor selector
   *
   * @throws `RangeError` when `fuzzy` is not above `0` and at most `1`
   */
  afterAnchor(options: {
    /** Literal or regular-expression anchor, matched line by line. */
    readonly text: string | RegExp;
    /** Literal or regular-expression text before which the selection stops, such as the next label. */
    readonly stopAt?: string | RegExp;
    /** Pages eligible for anchor matching. @defaultValue `"any"` */
    readonly page?: PageSelector;
    /** Zero-based matching anchor occurrence. @defaultValue `0` */
    readonly occurrence?: number;
    /** Whether literal anchor and `stopAt` matching preserves case. @defaultValue `false` */
    readonly caseSensitive?: boolean;
    /** Minimum similarity, above `0` and at most `1`, for fuzzy literal anchor and `stopAt` matches. */
    readonly fuzzy?: number;
  }): AfterAnchorSelector {
    return {
      kind: "afterAnchor",
      text: options.text,
      ...(options.stopAt === undefined ? {} : { stopAt: options.stopAt }),
      page: options.page ?? "any",
      occurrence: options.occurrence ?? 0,
      caseSensitive: options.caseSensitive ?? false,
      ...fuzzyOption(options.fuzzy),
    };
  },
  /**
   * Selects the visual lines printed below a text anchor, for labels written above their value.
   *
   * @remarks
   * The anchor's column bounds the selection, so a label sitting beside another one only reads the
   * value under itself. It ends at the next token on the anchor's line, or at the page's right edge,
   * and starts at the anchor's left edge when a token precedes the anchor on its line, or at the
   * page's left edge otherwise. A token belongs to the column when its center does. The first
   * line below the anchor in that column is selected when it starts within `maxDistance`, and each
   * further line up to `maxLines` when it starts within `maxDistance` of the previous one.
   *
   * @param options - Anchor matching, line count, and distance options
   * @returns A below-anchor selector
   *
   * @throws `RangeError` when `fuzzy` is not above `0` and at most `1`, `maxLines` is not a positive
   * integer, or `maxDistance` is negative
   */
  belowAnchor(options: {
    /** Literal or regular-expression anchor, matched line by line. */
    readonly text: string | RegExp;
    /** Pages eligible for anchor matching. @defaultValue `"any"` */
    readonly page?: PageSelector;
    /** Zero-based matching anchor occurrence. @defaultValue `0` */
    readonly occurrence?: number;
    /** Whether literal anchor matching preserves case. @defaultValue `false` */
    readonly caseSensitive?: boolean;
    /** Minimum similarity, above `0` and at most `1`, for a fuzzy literal anchor match. */
    readonly fuzzy?: number;
    /** Number of lines selected below the anchor. @defaultValue `1` */
    readonly maxLines?: number;
    /** Largest normalized vertical gap before a line. @defaultValue twice the anchor's height */
    readonly maxDistance?: number;
  }): BelowAnchorSelector {
    const maxLines = options.maxLines ?? 1;
    if (!Number.isInteger(maxLines) || maxLines < 1) {
      throw new RangeError("belowAnchor maxLines must be a positive integer.");
    }
    if (
      options.maxDistance !== undefined &&
      (!Number.isFinite(options.maxDistance) || options.maxDistance < 0)
    ) {
      throw new RangeError("belowAnchor maxDistance must be a non-negative number.");
    }
    return {
      kind: "belowAnchor",
      text: options.text,
      page: options.page ?? "any",
      occurrence: options.occurrence ?? 0,
      caseSensitive: options.caseSensitive ?? false,
      ...fuzzyOption(options.fuzzy),
      maxLines,
      ...(options.maxDistance === undefined ? {} : { maxDistance: options.maxDistance }),
    };
  },
};

/** Built-in post-capture transformation builders. */
export const transform = {
  /**
   * Returns a transform that trims leading and trailing whitespace.
   *
   * @returns A trim transform
   */
  trim(): TransformDefinition {
    return { kind: "trim" };
  },
  /**
   * Returns a transform that collapses whitespace and trims the value.
   *
   * @returns A whitespace normalization transform
   */
  normalizeWhitespace(): TransformDefinition {
    return { kind: "normalizeWhitespace" };
  },
  /**
   * Returns a text replacement transform.
   *
   * @param search - Literal or regular-expression search value
   * @param replacement - Replacement text
   * @returns A replacement transform
   */
  replace(search: string | RegExp, replacement: string): TransformDefinition {
    return { kind: "replace", search, replacement };
  },
  /**
   * Returns a localized number parsing transform.
   *
   * @param options - Decimal and grouping separators
   * @returns A number parsing transform
   */
  number(
    options: {
      /** Decimal separator replaced by `.` before parsing. @defaultValue `"."` */
      readonly decimalSeparator?: string;
      /** Grouping separators removed before parsing. @defaultValue `[" ", "\u00a0", ","]` */
      readonly groupSeparators?: readonly string[];
    } = {},
  ): TransformDefinition {
    return {
      kind: "number",
      decimalSeparator: options.decimalSeparator ?? ".",
      groupSeparators: options.groupSeparators ?? [" ", "\u00a0", ","],
    };
  },
  /**
   * Returns a calendar date parsing transform.
   *
   * @param format - Expected input date order
   * @param output - ISO date text or a JavaScript `Date`
   * @returns A date parsing transform
   */
  date(
    format: "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD",
    output: "iso" | "date" = "iso",
  ): TransformDefinition {
    return { kind: "date", format, output };
  },
  /**
   * Returns a constrained fuzzy-match transform.
   *
   * @remarks
   * A value is replaced only when one candidate is uniquely closest and falls within the maximum
   * edit distance. Ambiguous and distant values are returned unchanged.
   *
   * @param candidates - Explicit authoritative values
   * @param options - Edit-distance and normalization options
   * @returns A closest-match transform
   *
   * @throws `TypeError` when no candidate is given or a candidate is empty
   * @throws `RangeError` when `maxDistance` is not a non-negative integer
   */
  closestMatch(
    candidates: readonly string[],
    options: {
      /** Maximum accepted edit distance. @defaultValue `1` */
      readonly maxDistance?: number;
      /** Whether comparison ignores case. @defaultValue `true` */
      readonly ignoreCase?: boolean;
      /** Whether comparison ignores combining diacritical marks. @defaultValue `true` */
      readonly ignoreDiacritics?: boolean;
    } = {},
  ): TransformDefinition {
    if (candidates.length === 0 || candidates.some((candidate) => candidate.length === 0)) {
      throw new TypeError("closestMatch requires at least one non-empty candidate.");
    }
    const maxDistance = options.maxDistance ?? 1;
    if (!Number.isInteger(maxDistance) || maxDistance < 0) {
      throw new RangeError("closestMatch maxDistance must be a non-negative integer.");
    }
    return {
      kind: "closestMatch",
      candidates: [...candidates],
      maxDistance,
      ignoreCase: options.ignoreCase ?? true,
      ignoreDiacritics: options.ignoreDiacritics ?? true,
    };
  },
  /**
   * Returns an application-defined transform.
   *
   * @param name - Stable name included in field evidence
   * @param map - Synchronous or asynchronous value mapper
   * @returns A custom transform
   */
  custom(name: string, map: (value: unknown) => unknown): TransformDefinition {
    return { kind: "custom", name, map };
  },
};

/**
 * Defines a typed document profile and validates its language declaration.
 *
 * @typeParam S - Standard Schema validator type
 * @param profile - Profile definition
 * @returns The same profile with preserved type inference
 *
 * @throws `TypeError` when no non-empty OCR language is declared, `ocr.regions` is empty, or
 * `identify` declares neither a non-empty `text` nor a `test`, or an empty literal
 * @throws `RangeError` when an OCR region has an invalid page or a box outside the page
 */
export function defineProfile<S extends StandardSchemaV1>(
  profile: DocumentProfile<S>,
): DocumentProfile<S> {
  if (
    profile.languages.length === 0 ||
    profile.languages.some((language) => language.trim() === "")
  ) {
    throw new TypeError("A profile must declare at least one non-empty OCR language.");
  }
  const regions = profile.ocr?.regions;
  if (regions?.length === 0) {
    throw new TypeError("ocr.regions must declare at least one region; omit it for whole pages.");
  }
  for (const region of regions ?? []) {
    if (typeof region.page === "number" && (!Number.isInteger(region.page) || region.page < 1)) {
      throw new RangeError("An OCR region page must be a positive integer.");
    }
    const { x, y, width, height } = region.box;
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > 1 + Number.EPSILON * 4 ||
      y + height > 1 + Number.EPSILON * 4
    ) {
      throw new RangeError("An OCR region box must be a non-empty rectangle inside the page.");
    }
  }
  if (profile.identify) {
    const { text = [], test } = profile.identify;
    if (text.length === 0 && !test) {
      throw new TypeError("identify must declare at least one text entry or a test.");
    }
    if (text.some((entry) => entry === "")) {
      throw new TypeError("identify text entries must not be empty.");
    }
  }
  return profile;
}

/**
 * Determines whether a field-tree node is a field definition.
 *
 * @param value - Field-tree node to inspect
 * @returns `true` for scalar and repeated field leaves
 */
export function isFieldDefinition(value: FieldTree): value is FieldDefinition {
  return "_tag" in value && value._tag === "Field";
}

/**
 * Determines whether a field-tree node is a {@link field.table} definition.
 *
 * @param value - Field-tree node to inspect
 * @returns `true` for table leaves
 */
export function isTableDefinition(value: FieldTree): value is TableDefinition {
  return "_tag" in value && value._tag === "Table";
}

/**
 * Determines whether a field-tree node is a {@link field.firstOf} fallback.
 *
 * @param value - Field-tree node to inspect
 * @returns `true` for fallback leaves
 */
export function isFirstOfDefinition(value: FieldTree): value is FirstOfDefinition {
  return "_tag" in value && value._tag === "FirstOf";
}
