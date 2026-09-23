import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  AbortError,
  DisposedError,
  ExtractionError,
  LimitExceededError,
  OcrError,
  PdfEngineError,
  ScribeError,
  ValidationError,
} from "./errors.js";
import { extractProfile, type ExtractPage, type ProfileExtraction } from "./extract.js";
import type { DocumentProfile } from "./profile.js";
import type {
  BinaryInput,
  CreateScribeOptions,
  Diagnostic,
  ExtractionResult,
  PageBitmap,
  PageDiagnostic,
  ParseOptions,
  PdfDocument,
  PdfPage,
  Scribe,
  ScribeLimits,
  TextToken,
} from "./types.js";

/** Default resource limits used by {@link createScribe}. */
export const DEFAULT_LIMITS: ScribeLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxPages: 100,
  maxPixelsPerPage: 25_000_000,
  concurrency: 1,
};

/** Minimum native alphanumeric characters below which a page is considered image-only. */
const MIN_NATIVE_CHARACTERS = 16;
/** Render density used for OCR bitmaps. */
const OCR_DPI = 300;

/**
 * Throws when a cancellation signal has already fired.
 *
 * @param signal - Optional cancellation signal
 * @throws {@link AbortError} when the signal is aborted, with its reason as `cause`
 */
function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AbortError("The extraction was aborted.", { cause: signal.reason });
  }
}

/**
 * Views binary input as bytes without copying.
 *
 * @param input - PDF bytes as an `ArrayBuffer` or `Uint8Array`
 * @returns A `Uint8Array` over the same memory
 */
function bytesFrom(input: BinaryInput): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Maps values with an async function while bounding the number of in-flight calls.
 *
 * @typeParam T - Input value type
 * @typeParam U - Mapped value type
 * @param values - Values to map
 * @param concurrency - Maximum number of concurrent `map` calls
 * @param map - Async mapper applied to each value
 * @returns Mapped values in input order
 */
async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = Array.from<U>({ length: values.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await map(values[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

/** Per-page state updated as native extraction and OCR progress. */
interface MutablePageState {
  readonly page: PdfPage;
  nativeTokens: readonly TextToken[];
  tokens: readonly TextToken[];
  source: "native" | "ocr";
  durationMs: number;
  ocrConfidence?: number;
  ocrSkippedReason?: "blank-page";
}

/**
 * Counts Unicode letters and digits across tokens.
 *
 * @param tokens - Tokens to inspect
 * @returns Number of alphanumeric characters
 */
function nativeCharacterCount(tokens: readonly TextToken[]): number {
  return tokens.reduce((sum, token) => sum + (token.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
}

/**
 * Estimates the pixel count of a page rendered at a given density.
 *
 * @param page - Page whose size is expressed in PDF points
 * @param dpi - Target render density
 * @returns Width times height in pixels, rounded up per dimension
 */
function estimatedPixels(page: PdfPage, dpi: number): number {
  return Math.ceil((page.width * dpi) / 72) * Math.ceil((page.height * dpi) / 72);
}

/**
 * Converts internal page state into public page diagnostics.
 *
 * @param states - Final page states
 * @returns One diagnostic per page, in page order
 */
function pageDiagnostics(states: readonly MutablePageState[]): readonly PageDiagnostic[] {
  return states.map((state) => ({
    page: state.page.number,
    source: state.source,
    nativeCharacterCount: nativeCharacterCount(state.nativeTokens),
    tokenCount: state.tokens.length,
    durationMs: state.durationMs,
    ...(state.ocrConfidence === undefined ? {} : { ocrConfidence: state.ocrConfidence }),
    ...(state.ocrSkippedReason === undefined ? {} : { ocrSkippedReason: state.ocrSkippedReason }),
  }));
}

/**
 * Determines whether a rendered page is visually blank.
 *
 * @remarks
 * A pixel counts as ink when its luminance, composited over white, is below 245. The page is blank
 * when at most 0.005% of pixels (and never fewer than 8) are ink.
 *
 * @param bitmap - Grayscale or RGBA page render
 * @param signal - Optional cancellation signal, checked every million pixels
 * @returns `true` when the page contains no meaningful ink
 * @throws {@link AbortError} when the signal fires during the scan
 */
function isBlankBitmap(bitmap: PageBitmap, signal?: AbortSignal): boolean {
  const pixelCount = bitmap.width * bitmap.height;
  const maximumNonWhitePixels = Math.max(8, Math.floor(pixelCount * 0.000_05));
  let nonWhitePixels = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (pixel % 1_000_000 === 0) abortIfNeeded(signal);
    let luminance: number;
    if (bitmap.format === "gray8") {
      luminance = bitmap.data[pixel] ?? 0;
    } else {
      const offset = pixel * 4;
      const red = bitmap.data[offset] ?? 0;
      const green = bitmap.data[offset + 1] ?? 0;
      const blue = bitmap.data[offset + 2] ?? 0;
      const alpha = (bitmap.data[offset + 3] ?? 255) / 255;
      const opaqueLuminance = 0.299 * red + 0.587 * green + 0.114 * blue;
      luminance = 255 - (255 - opaqueLuminance) * alpha;
    }
    if (luminance < 245) {
      nonWhitePixels += 1;
      if (nonWhitePixels > maximumNonWhitePixels) return false;
    }
  }
  return true;
}

/**
 * Projects page state into the input expected by the profile extractor.
 *
 * @param states - Current page states
 * @returns Page numbers with their current tokens
 */
function asExtractPages(states: readonly MutablePageState[]): readonly ExtractPage[] {
  return states.map((state) => ({ number: state.page.number, tokens: state.tokens }));
}

/**
 * Converts Standard Schema issues into validator-independent issues.
 *
 * @param issues - Issues reported by the profile schema
 * @returns Issues whose path segments are plain property keys
 */
function normalizeIssues(issues: readonly StandardSchemaV1.Issue[]) {
  return issues.map((issue) => ({
    message: issue.message,
    ...(issue.path
      ? {
          path: issue.path.map((segment) =>
            typeof segment === "object" && segment !== null && "key" in segment
              ? segment.key
              : segment,
          ),
        }
      : {}),
  }));
}

/**
 * Creates a long-lived structured PDF extraction pipeline.
 *
 * @remarks
 * Adapter construction is handled by their respective packages. Reuse the returned instance across
 * parse operations and call {@link Scribe.close} during application shutdown.
 *
 * @param options - PDF adapter, optional OCR adapter, and resource limits
 * @returns A reusable Scribe instance
 *
 * @throws {@link LimitExceededError}
 * Thrown immediately when the configured concurrency is not a positive integer.
 *
 * @example
 * ```ts
 * const scribe = createScribe({ pdf, ocr });
 * try {
 *   const result = await scribe.parse(bytes, profile);
 * } finally {
 *   await scribe.close();
 * }
 * ```
 *
 * @public
 */
export function createScribe(options: CreateScribeOptions): Scribe {
  const limits: ScribeLimits = { ...DEFAULT_LIMITS, ...options.limits };
  if (!Number.isInteger(limits.concurrency) || limits.concurrency < 1) {
    throw new LimitExceededError(
      "Concurrency must be a positive integer.",
      "concurrency",
      limits.concurrency,
      Number.MAX_SAFE_INTEGER,
    );
  }

  let closed = false;
  let closePromise: Promise<void> | undefined;

  /**
   * Renders a page, skips it when blank, and replaces its tokens with OCR output.
   *
   * @param state - Page state updated in place
   * @param profile - Profile providing the OCR languages
   * @param signal - Optional cancellation signal
   * @returns A promise that resolves once the page state is updated
   * @throws {@link OcrError} when no OCR engine is configured or recognition fails
   * @throws {@link LimitExceededError} when the render would exceed `maxPixelsPerPage`
   */
  const runOcr = async (
    state: MutablePageState,
    profile: DocumentProfile,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!options.ocr) {
      throw new OcrError("OCR is required by this document but no OCR engine was configured.");
    }
    abortIfNeeded(signal);
    const pixels = estimatedPixels(state.page, OCR_DPI);
    if (pixels > limits.maxPixelsPerPage) {
      throw new LimitExceededError(
        `Page ${state.page.number} would render ${pixels} pixels, above the configured limit.`,
        "pixels",
        pixels,
        limits.maxPixelsPerPage,
      );
    }
    const started = performance.now();
    try {
      const bitmap = await state.page.render({
        dpi: OCR_DPI,
        grayscale: true,
        ...(signal ? { signal } : {}),
      });
      abortIfNeeded(signal);
      if (isBlankBitmap(bitmap, signal)) {
        state.ocrSkippedReason = "blank-page";
        state.durationMs += performance.now() - started;
        return;
      }
      const result = await options.ocr.recognize(bitmap, {
        languages: profile.languages,
        ...(signal ? { signal } : {}),
      });
      state.tokens = result.tokens;
      state.source = "ocr";
      state.durationMs += performance.now() - started;
      if (result.confidence !== undefined) state.ocrConfidence = result.confidence;
    } catch (cause) {
      if (cause instanceof ScribeError) throw cause;
      throw new OcrError(`OCR failed on page ${state.page.number}.`, { cause });
    }
  };

  return {
    /** {@inheritDoc Scribe.parse} */
    async parse<S extends StandardSchemaV1>(
      input: BinaryInput,
      profile: DocumentProfile<S>,
      parseOptions: ParseOptions = {},
    ): Promise<ExtractionResult<StandardSchemaV1.InferOutput<S>>> {
      if (closed) throw new DisposedError();
      abortIfNeeded(parseOptions.signal);
      const bytes = bytesFrom(input);
      if (bytes.byteLength > limits.maxBytes) {
        throw new LimitExceededError(
          `The PDF is ${bytes.byteLength} bytes, above the configured limit.`,
          "bytes",
          bytes.byteLength,
          limits.maxBytes,
        );
      }

      let document: PdfDocument;
      try {
        document = await options.pdf.open(bytes, {
          ...(parseOptions.password ? { password: parseOptions.password } : {}),
          ...(parseOptions.signal ? { signal: parseOptions.signal } : {}),
        });
      } catch (cause) {
        if (cause instanceof ScribeError) throw cause;
        throw new PdfEngineError("The PDF engine could not open the document.", { cause });
      }

      try {
        if (document.pageCount > limits.maxPages) {
          throw new LimitExceededError(
            `The PDF contains ${document.pageCount} pages, above the configured limit.`,
            "pages",
            document.pageCount,
            limits.maxPages,
          );
        }

        const pages = await mapConcurrent(
          Array.from({ length: document.pageCount }, (_, index) => index),
          limits.concurrency,
          async (index): Promise<MutablePageState> => {
            abortIfNeeded(parseOptions.signal);
            const page = await document.getPage(index);
            if ((parseOptions.ocr ?? "auto") === "always") {
              return { page, nativeTokens: [], tokens: [], source: "native", durationMs: 0 };
            }
            const started = performance.now();
            try {
              const tokens = await page.extractText(parseOptions.signal);
              return {
                page,
                nativeTokens: tokens,
                tokens,
                source: "native",
                durationMs: performance.now() - started,
              };
            } catch (cause) {
              if (cause instanceof ScribeError) throw cause;
              throw new PdfEngineError(`Native text extraction failed on page ${page.number}.`, {
                cause,
              });
            }
          },
        );

        const mode = parseOptions.ocr ?? "auto";
        if (mode === "always") {
          await mapConcurrent(pages, limits.concurrency, (state) =>
            runOcr(state, profile, parseOptions.signal),
          );
        }

        let extraction: ProfileExtraction = await extractProfile(profile, asExtractPages(pages));
        if (mode === "auto") {
          const ocrPages = new Set<number>(extraction.implicatedPages);
          for (const state of pages) {
            if (nativeCharacterCount(state.nativeTokens) < MIN_NATIVE_CHARACTERS) {
              ocrPages.add(state.page.number);
            }
          }
          if (ocrPages.size > 0 && options.ocr) {
            await mapConcurrent(
              pages.filter((state) => ocrPages.has(state.page.number)),
              limits.concurrency,
              (state) => runOcr(state, profile, parseOptions.signal),
            );
            extraction = await extractProfile(profile, asExtractPages(pages));
          }
        }

        if (extraction.missingRequired.length > 0) {
          throw new ExtractionError(
            `Required fields could not be extracted: ${extraction.missingRequired.join(", ")}.`,
            extraction.missingRequired,
          );
        }

        const validation = await profile.schema["~standard"].validate(extraction.value);
        if (validation.issues) {
          throw new ValidationError(normalizeIssues(validation.issues), extraction.value);
        }

        const diagnostics: Diagnostic[] = [...extraction.diagnostics];
        for (const state of pages) {
          if (state.ocrSkippedReason === "blank-page") {
            diagnostics.push({
              level: "info",
              code: "OCR_SKIPPED_BLANK_PAGE",
              message: `OCR was skipped because page ${state.page.number} is blank.`,
              page: state.page.number,
            });
          }
        }
        if (mode === "auto" && pages.some((state) => state.source === "ocr")) {
          diagnostics.push({
            level: "info",
            code: "OCR_FALLBACK_USED",
            message:
              "OCR was used only on pages that lacked usable native text or required fields.",
          });
        }

        return {
          data: validation.value,
          evidence: extraction.evidence,
          pages: pageDiagnostics(pages),
          diagnostics,
        };
      } finally {
        await document.close();
      }
    },

    /** {@inheritDoc Scribe.close} */
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = Promise.allSettled([options.pdf.close(), options.ocr?.close()]).then(
        (results) => {
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (failure) throw failure.reason;
          return undefined;
        },
      );
      return closePromise;
    },
  };
}
