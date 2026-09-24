import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DocumentProfile } from "./profile.js";

/** Binary PDF input accepted by {@link Scribe.parse}. */
export type BinaryInput = Uint8Array | ArrayBuffer;

/** JSON Pointer identifying a field in the extracted output. */
export type JsonPointer = `/${string}`;

/** Origin of a positioned text token. */
export type TextSource = "native" | "ocr";

/** OCR policy applied by {@link Scribe.parse}. */
export type OcrMode = "auto" | "always" | "never";

/** A normalized page rectangle with a top-left origin. */
export interface BoundingBox {
  /** Horizontal position between `0` and `1`. */
  readonly x: number;
  /** Vertical position between `0` and `1`. */
  readonly y: number;
  /** Width relative to the page width. */
  readonly width: number;
  /** Height relative to the page height. */
  readonly height: number;
}

/** A word or text fragment positioned on a PDF page. */
export interface TextToken {
  /** Recognized or natively extracted text. */
  readonly text: string;
  /** Normalized source rectangle. */
  readonly box: BoundingBox;
  /** Extraction method that produced the token. */
  readonly source: TextSource;
  /** OCR confidence normalized between `0` and `1`. */
  readonly confidence?: number;
  /** Stable line grouping index within a page. */
  readonly lineIndex?: number;
}

/** Raw page image exchanged between PDF and OCR adapters. */
export interface PageBitmap {
  /** Interleaved pixel bytes. */
  readonly data: Uint8Array;
  /** Bitmap width in pixels. */
  readonly width: number;
  /** Bitmap height in pixels. */
  readonly height: number;
  /** Pixel layout used by {@link PageBitmap.data}. */
  readonly format: "gray8" | "rgba8";
  /** Pixel density of the rendered image when it is known. */
  readonly dpi?: number;
}

/** A straight line drawn on a page, such as a table border, in normalized coordinates. */
export interface PageRule {
  /** Horizontal position of a vertical rule, or vertical position of a horizontal one. */
  readonly position: number;
  /** Top of a vertical rule, or left end of a horizontal one. */
  readonly start: number;
  /** Bottom of a vertical rule, or right end of a horizontal one. */
  readonly end: number;
}

/** Rules drawn on one page, as returned by {@link PdfPage.rules}. */
export interface PageRules {
  /** Vertical rules, from left to right. */
  readonly vertical: readonly PageRule[];
  /** Horizontal rules, from top to bottom. */
  readonly horizontal: readonly PageRule[];
}

/** Options passed to {@link PdfPage.render}. */
export interface PdfRenderOptions {
  /** Target pixel density. */
  readonly dpi: number;
  /** Whether to render one grayscale byte per pixel. */
  readonly grayscale: boolean;
  /** Signal used to cancel rendering. */
  readonly signal?: AbortSignal;
}

/** One open page owned by a {@link PdfDocument}. */
export interface PdfPage {
  /** Zero-based page index. */
  readonly index: number;
  /** One-based page number. */
  readonly number: number;
  /** Page width in PDF points. */
  readonly width: number;
  /** Page height in PDF points. */
  readonly height: number;
  /**
   * Extracts positioned native text.
   *
   * @param signal - Optional cancellation signal
   * @returns Native text tokens in reading order
   */
  extractText(signal?: AbortSignal): Promise<readonly TextToken[]>;
  /**
   * Renders the page to a bitmap.
   *
   * @param options - Render density, color mode, and cancellation signal
   * @returns The rendered page bitmap
   */
  render(options: PdfRenderOptions): Promise<PageBitmap>;
  /**
   * Lists the straight rules drawn on the page, used to find table column boundaries.
   *
   * @remarks
   * Optional: adapters that cannot read vector graphics omit the method.
   *
   * @param signal - Optional cancellation signal
   * @returns The page's vertical and horizontal rules
   */
  rules?(signal?: AbortSignal): Promise<PageRules>;
}

/** An open PDF document whose resources must be released with {@link PdfDocument.close}. */
export interface PdfDocument {
  /** Number of pages in the document. */
  readonly pageCount: number;
  /**
   * Loads a page.
   *
   * @param index - Zero-based page index
   * @returns The loaded page
   */
  getPage(index: number): Promise<PdfPage>;
  /** Releases all pages and document resources. This operation must be idempotent. */
  close(): Promise<void>;
}

/** Options used by {@link PdfEngine.open}. */
export interface PdfOpenOptions {
  /** Password for an encrypted document. */
  readonly password?: string;
  /** Signal used to cancel document opening. */
  readonly signal?: AbortSignal;
}

/** Replaceable adapter contract for PDF loading, native text extraction, and rendering. */
export interface PdfEngine {
  /**
   * Opens a PDF from memory.
   *
   * @param input - Complete PDF bytes
   * @param options - Password and cancellation options
   * @returns An open document
   */
  open(input: Uint8Array, options?: PdfOpenOptions): Promise<PdfDocument>;
  /** Releases engine-level resources. This operation must be idempotent. */
  close(): Promise<void>;
}

/** Options passed to {@link OcrEngine.recognize}. */
export interface OcrRecognizeOptions {
  /** Explicit Tesseract-compatible language identifiers. */
  readonly languages: readonly string[];
  /** Signal used to stop waiting for recognition. */
  readonly signal?: AbortSignal;
}

/** Positioned text returned by an OCR engine. */
export interface OcrResult {
  /** OCR tokens in reading order. */
  readonly tokens: readonly TextToken[];
  /** Optional page-level confidence between `0` and `1`. */
  readonly confidence?: number;
}

/** Replaceable adapter contract for bitmap OCR. */
export interface OcrEngine {
  /**
   * Recognizes text in a page bitmap.
   *
   * @param bitmap - Rendered page pixels
   * @param options - Explicit languages and cancellation signal
   * @returns Positioned OCR tokens
   */
  recognize(bitmap: PageBitmap, options: OcrRecognizeOptions): Promise<OcrResult>;
  /** Terminates all OCR resources. This operation must be idempotent. */
  close(): Promise<void>;
}

/** Resource limits enforced by the extraction pipeline. */
export interface ScribeLimits {
  /** Maximum accepted input size in bytes. */
  readonly maxBytes: number;
  /** Maximum number of pages per document. */
  readonly maxPages: number;
  /** Maximum rendered pixel count for one page. */
  readonly maxPixelsPerPage: number;
  /** Maximum page-level work performed concurrently within one parse. */
  readonly concurrency: number;
}

/** Dependencies and optional limits used to create a {@link Scribe} instance. */
export interface CreateScribeOptions {
  /** PDF adapter used for every parse operation. */
  readonly pdf: PdfEngine;
  /** Optional OCR adapter. Required by `auto` fallback and `always` mode. */
  readonly ocr?: OcrEngine;
  /** Partial overrides for {@link ScribeLimits}. */
  readonly limits?: Partial<ScribeLimits>;
}

/** Per-call extraction options. */
export interface ParseOptions {
  /** OCR policy. @defaultValue `"auto"` */
  readonly ocr?: OcrMode;
  /** Password for an encrypted PDF. */
  readonly password?: string;
  /** Signal used to cancel the full pipeline. */
  readonly signal?: AbortSignal;
}

/** Per-call options of {@link Scribe.identify}. */
export interface IdentifyOptions {
  /** Password for an encrypted PDF. */
  readonly password?: string;
  /** Signal used to cancel identification. */
  readonly signal?: AbortSignal;
}

/** Label matched by a fuzzy anchor selector. */
export interface AnchorEvidence {
  /** Space-joined text of the tokens that matched the anchor label. */
  readonly text: string;
  /** Similarity between the declared label and {@link AnchorEvidence.text}, between `0` and `1`. */
  readonly score: number;
}

/** Traceable source material used to produce one output field. */
export interface FieldEvidence {
  /** One-based source page number. */
  readonly page: number;
  /** Normalized source region. */
  readonly box: BoundingBox;
  /**
   * Raw text of the tokens backing the value, before field transformations. With a `pattern`, only
   * the tokens overlapping the captured group; without one, every selected token.
   */
  readonly text: string;
  /** Native extraction or OCR. */
  readonly method: TextSource;
  /** Lowest OCR confidence among the tokens backing the value. */
  readonly confidence?: number;
  /** Ordered names of transformations applied to the captured value. */
  readonly transformations: readonly string[];
  /** Zero-based index of the `field.firstOf` alternative that produced the value. */
  readonly alternative?: number;
  /** Anchor label matched on this page, when the selector matched it with `fuzzy`. */
  readonly anchor?: AnchorEvidence;
}

/** Non-fatal information or warning produced during extraction. */
export interface Diagnostic {
  /** Diagnostic severity. */
  readonly level: "info" | "warning";
  /** Stable machine-readable diagnostic identifier. */
  readonly code: string;
  /** Human-readable explanation. */
  readonly message: string;
  /** Related one-based page number, when applicable. */
  readonly page?: number;
  /** Related output field, when applicable. */
  readonly path?: JsonPointer;
}

/** Per-page performance and extraction metadata. */
export interface PageDiagnostic {
  /** One-based page number. */
  readonly page: number;
  /** Final text source used for the page. `mixed` merges native text with OCR'd regions. */
  readonly source: TextSource | "mixed";
  /** Number of native alphanumeric characters detected before OCR. */
  readonly nativeCharacterCount: number;
  /** Number of final positioned tokens. */
  readonly tokenCount: number;
  /** Time spent extracting and optionally recognizing the page, in milliseconds. */
  readonly durationMs: number;
  /** Optional page-level OCR confidence. */
  readonly ocrConfidence?: number;
  /** Reason recognition was skipped after rendering. */
  readonly ocrSkippedReason?: "blank-page";
  /** Number of declared OCR regions recognized on the page, when the profile declares regions. */
  readonly ocrRegionCount?: number;
}

/**
 * Structured data plus traceability and diagnostics for one parsed document.
 *
 * @typeParam T - Validated output type inferred from the profile schema
 */
export interface ExtractionResult<T> {
  /** Schema-validated output. */
  readonly data: T;
  /** Field evidence indexed by JSON Pointer. */
  readonly evidence: Readonly<Record<JsonPointer, readonly FieldEvidence[]>>;
  /** Page-level extraction diagnostics. */
  readonly pages: readonly PageDiagnostic[];
  /** Non-fatal pipeline diagnostics. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Long-lived structured PDF extraction pipeline. */
export interface Scribe {
  /**
   * Extracts and validates a PDF with a declarative profile.
   *
   * @typeParam S - Standard Schema type carried by the profile
   * @param input - PDF bytes as an `ArrayBuffer` or `Uint8Array`
   * @param profile - Extraction profile and output schema
   * @param options - OCR, password, and cancellation options
   * @returns Validated data, evidence, and diagnostics
   *
   * @throws {@link InvalidPdfError}
   * Thrown when the PDF is malformed or unsupported.
   *
   * @throws {@link ProfileMismatchError}
   * Thrown before any rendering or OCR when the profile declares `identify` and the document's
   * native text does not satisfy it.
   *
   * @throws {@link ExtractionError}
   * Thrown when required fields cannot be extracted.
   *
   * @throws {@link ValidationError}
   * Thrown when the extracted value fails schema validation.
   */
  parse<S extends StandardSchemaV1>(
    input: BinaryInput,
    profile: DocumentProfile<S>,
    options?: ParseOptions,
  ): Promise<ExtractionResult<StandardSchemaV1.InferOutput<S>>>;
  /**
   * Picks the profile describing a document from its native text layer, without rendering or OCR.
   *
   * @typeParam P - Candidate profile type
   * @param input - PDF bytes as an `ArrayBuffer` or `Uint8Array`
   * @param profiles - Candidate profiles, each declaring `identify`
   * @param options - Password and cancellation options
   * @returns The only candidate whose `identify` rules the document satisfies
   *
   * @throws `TypeError`
   * Thrown before the document is opened when no profile is given or one lacks `identify`.
   *
   * @throws {@link ProfileMismatchError}
   * Thrown when the document matches no candidate.
   *
   * @throws {@link AmbiguousProfileError}
   * Thrown when the document matches several candidates, listed in `profileIds`.
   */
  identify<P extends DocumentProfile>(
    input: BinaryInput,
    profiles: readonly P[],
    options?: IdentifyOptions,
  ): Promise<P>;
  /** Closes configured engines. Repeated calls return the same completed operation. */
  close(): Promise<void>;
}
