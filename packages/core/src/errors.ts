import type { JsonPointer } from "./types.js";

/** Stable discriminator shared by all public Scribe errors. */
export type ScribeErrorCode =
  | "INVALID_PDF"
  | "ENCRYPTED_PDF"
  | "LIMIT_EXCEEDED"
  | "PDF_ENGINE_ERROR"
  | "OCR_ERROR"
  | "EXTRACTION_ERROR"
  | "VALIDATION_ERROR"
  | "ABORTED"
  | "DISPOSED";

/** Base class for errors intentionally exposed by the extraction pipeline. */
export abstract class ScribeError extends Error {
  /** Stable machine-readable error code. */
  abstract readonly code: ScribeErrorCode;

  /**
   * Creates a Scribe error whose `name` matches the concrete subclass.
   *
   * @param message - Human-readable explanation
   * @param options - Native error options, typically carrying the underlying `cause`
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when a PDF cannot be parsed because it is malformed or unsupported. */
export class InvalidPdfError extends ScribeError {
  readonly code = "INVALID_PDF" as const;
}

/** Thrown when a PDF password is missing or invalid. */
export class EncryptedPdfError extends ScribeError {
  readonly code = "ENCRYPTED_PDF" as const;
}

/** Thrown before work exceeds a configured resource limit. */
export class LimitExceededError extends ScribeError {
  readonly code = "LIMIT_EXCEEDED" as const;

  /**
   * Creates a limit error.
   *
   * @param message - Human-readable explanation
   * @param limit - Limit category that was exceeded
   * @param actual - Observed value
   * @param maximum - Configured maximum
   */
  constructor(
    message: string,
    readonly limit: "bytes" | "pages" | "pixels" | "concurrency",
    readonly actual: number,
    readonly maximum: number,
  ) {
    super(message);
  }
}

/** Thrown when a PDF adapter fails outside known invalid or encrypted document cases. */
export class PdfEngineError extends ScribeError {
  readonly code = "PDF_ENGINE_ERROR" as const;
}

/** Thrown when OCR initialization or recognition fails. */
export class OcrError extends ScribeError {
  readonly code = "OCR_ERROR" as const;
}

/** Thrown when required profile fields remain unresolved after the selected OCR policy. */
export class ExtractionError extends ScribeError {
  readonly code = "EXTRACTION_ERROR" as const;

  /**
   * Creates an extraction error.
   *
   * @param message - Human-readable explanation
   * @param missingPaths - Required output fields that could not be produced
   * @param options - Native error options
   */
  constructor(
    message: string,
    readonly missingPaths: readonly JsonPointer[],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Validator-independent representation of a Standard Schema issue. */
export interface ValidationIssue {
  /** Human-readable validation message. */
  readonly message: string;
  /** Standard Schema property path. */
  readonly path?: readonly PropertyKey[];
}

/** Thrown when extracted data does not satisfy the profile's Standard Schema. */
export class ValidationError extends ScribeError {
  readonly code = "VALIDATION_ERROR" as const;

  /**
   * Creates a validation error.
   *
   * @param issues - Normalized Standard Schema issues
   * @param input - Raw intermediate value that failed validation
   */
  constructor(
    readonly issues: readonly ValidationIssue[],
    readonly input: unknown,
  ) {
    super("The extracted value does not satisfy the profile schema.");
  }
}

/** Thrown when an operation observes an aborted signal. */
export class AbortError extends ScribeError {
  readonly code = "ABORTED" as const;

  /**
   * Creates an abort error.
   *
   * @param message - Human-readable explanation
   * @param options - Native error options, typically carrying the signal's abort reason as `cause`
   */
  constructor(message = "The extraction was aborted.", options?: ErrorOptions) {
    super(message, options);
  }
}

/** Thrown when a closed Scribe instance or adapter is used again. */
export class DisposedError extends ScribeError {
  readonly code = "DISPOSED" as const;

  /** Creates a disposed-instance error with a fixed message. */
  constructor() {
    super("This Scribe instance has already been closed.");
  }
}

/** Union of every error intentionally exposed by the public API. */
export type AnyScribeError =
  | InvalidPdfError
  | EncryptedPdfError
  | LimitExceededError
  | PdfEngineError
  | OcrError
  | ExtractionError
  | ValidationError
  | AbortError
  | DisposedError;
