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
}

/** Selector supported by declarative fields. */
export type TextSelector = RegionSelector | AnchorSelector | AfterAnchorSelector;

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

/** Recursive object tree whose leaves are field definitions. */
export type FieldTree = FieldDefinition | FirstOfDefinition | { readonly [key: string]: FieldTree };

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
  }): AnchorSelector {
    return {
      kind: "anchor",
      text: options.text,
      offset: options.offset,
      page: options.page ?? "any",
      occurrence: options.occurrence ?? 0,
      caseSensitive: options.caseSensitive ?? false,
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
  }): AfterAnchorSelector {
    return {
      kind: "afterAnchor",
      text: options.text,
      ...(options.stopAt === undefined ? {} : { stopAt: options.stopAt }),
      page: options.page ?? "any",
      occurrence: options.occurrence ?? 0,
      caseSensitive: options.caseSensitive ?? false,
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
 * @throws `TypeError` when no non-empty OCR language is declared
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
 * Determines whether a field-tree node is a {@link field.firstOf} fallback.
 *
 * @param value - Field-tree node to inspect
 * @returns `true` for fallback leaves
 */
export function isFirstOfDefinition(value: FieldTree): value is FirstOfDefinition {
  return "_tag" in value && value._tag === "FirstOf";
}
