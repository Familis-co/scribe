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

/** Selector supported by declarative fields. */
export type TextSelector = RegionSelector | AnchorSelector;

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

/** Recursive object tree whose leaves are field definitions. */
export type FieldTree = FieldDefinition | { readonly [key: string]: FieldTree };

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
  /** Emit a diagnostic when OCR confidence for the selected region is below this value. */
  readonly warnBelowConfidence?: number;
  /** Value returned when selection or capture produces no value. */
  readonly defaultValue?: unknown;
}

function makeField(options: FieldOptions, many: boolean): FieldDefinition {
  if (
    options.warnBelowConfidence !== undefined &&
    (!Number.isFinite(options.warnBelowConfidence) ||
      options.warnBelowConfidence < 0 ||
      options.warnBelowConfidence > 1)
  ) {
    throw new RangeError("warnBelowConfidence must be between 0 and 1.");
  }
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
    readonly text: string | RegExp;
    readonly offset: BoundingBox;
    readonly page?: PageSelector;
    readonly occurrence?: number;
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
};

/** Built-in post-capture transformation builders. */
export const transform = {
  /** Returns a transform that trims leading and trailing whitespace. */
  trim(): TransformDefinition {
    return { kind: "trim" };
  },
  /** Returns a transform that collapses whitespace and trims the value. */
  normalizeWhitespace(): TransformDefinition {
    return { kind: "normalizeWhitespace" };
  },
  /**
   * Returns a text replacement transform.
   *
   * @param search - Literal or regular-expression search value
   * @param replacement - Replacement text
   */
  replace(search: string | RegExp, replacement: string): TransformDefinition {
    return { kind: "replace", search, replacement };
  },
  /**
   * Returns a localized number parsing transform.
   *
   * @param options - Decimal and grouping separators
   */
  number(
    options: {
      readonly decimalSeparator?: string;
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
   */
  closestMatch(
    candidates: readonly string[],
    options: {
      readonly maxDistance?: number;
      readonly ignoreCase?: boolean;
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
