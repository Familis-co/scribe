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
import type { DocumentProfile, OcrRegion } from "./profile.js";
import type {
  BinaryInput,
  BoundingBox,
  CreateScribeOptions,
  Diagnostic,
  ExtractionResult,
  OcrEngine,
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
  source: "native" | "ocr" | "mixed";
  durationMs: number;
  ocrConfidence?: number;
  ocrSkippedReason?: "blank-page";
  ocrRegionCount?: number;
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
    ...(state.ocrRegionCount === undefined ? {} : { ocrRegionCount: state.ocrRegionCount }),
  }));
}

/**
 * Resolves declared OCR regions to the pages they apply to.
 *
 * @param regions - Regions declared by the profile
 * @param pageCount - Number of pages in the document
 * @returns Region boxes by one-based page number, omitting pages without a region
 */
function regionsByPage(
  regions: readonly OcrRegion[],
  pageCount: number,
): ReadonlyMap<number, readonly BoundingBox[]> {
  const byPage = new Map<number, BoundingBox[]>();
  for (const region of regions) {
    const pages =
      region.page === "any"
        ? Array.from({ length: pageCount }, (_, index) => index + 1)
        : [region.page === "first" ? 1 : region.page === "last" ? pageCount : region.page];
    for (const page of pages) {
      if (page < 1 || page > pageCount) continue;
      byPage.set(page, [...(byPage.get(page) ?? []), region.box]);
    }
  }
  return byPage;
}

/**
 * Copies the pixels of a normalized rectangle out of a bitmap.
 *
 * @remarks
 * The rectangle is widened to whole pixels, and the returned box is the exact area that was copied
 * so OCR coordinates can be mapped back onto the page.
 *
 * @param bitmap - Page render
 * @param box - Normalized rectangle to copy
 * @returns The cropped bitmap and its normalized page area, or `undefined` when it has no pixels
 */
function cropBitmap(
  bitmap: PageBitmap,
  box: BoundingBox,
): { readonly bitmap: PageBitmap; readonly box: BoundingBox } | undefined {
  const left = Math.max(0, Math.floor(box.x * bitmap.width + 1e-6));
  const top = Math.max(0, Math.floor(box.y * bitmap.height + 1e-6));
  const right = Math.min(bitmap.width, Math.ceil((box.x + box.width) * bitmap.width - 1e-6));
  const bottom = Math.min(bitmap.height, Math.ceil((box.y + box.height) * bitmap.height - 1e-6));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return undefined;

  const channels = bitmap.format === "gray8" ? 1 : 4;
  const data = new Uint8Array(width * height * channels);
  for (let row = 0; row < height; row += 1) {
    const start = ((top + row) * bitmap.width + left) * channels;
    data.set(bitmap.data.subarray(start, start + width * channels), row * width * channels);
  }
  return {
    bitmap: {
      data,
      width,
      height,
      format: bitmap.format,
      ...(bitmap.dpi === undefined ? {} : { dpi: bitmap.dpi }),
    },
    box: {
      x: left / bitmap.width,
      y: top / bitmap.height,
      width: width / bitmap.width,
      height: height / bitmap.height,
    },
  };
}

/**
 * Maps a token from crop coordinates to page coordinates.
 *
 * @param token - OCR token normalized to the crop
 * @param crop - Normalized page area the crop was taken from
 * @returns The token normalized to the page
 */
function toPageToken(token: TextToken, crop: BoundingBox): TextToken {
  return {
    ...token,
    box: {
      x: crop.x + token.box.x * crop.width,
      y: crop.y + token.box.y * crop.height,
      width: token.box.width * crop.width,
      height: token.box.height * crop.height,
    },
  };
}

/**
 * Vertical center of a token.
 *
 * @param token - Token to measure
 * @returns The normalized vertical center
 */
const centerY = (token: TextToken): number => token.box.y + token.box.height / 2;

/**
 * Rebuilds line indices from token geometry.
 *
 * @remarks
 * Native and OCR line indices come from different numbering schemes, so a merged page groups
 * tokens by position instead: a token joins the current line when its vertical center lies above
 * the line's bottom edge.
 *
 * @param tokens - Tokens of one page from any source
 * @returns The tokens in reading order with geometric line indices
 */
function relineTokens(tokens: readonly TextToken[]): readonly TextToken[] {
  const lines: Array<{ bottom: number; tokens: TextToken[] }> = [];
  for (const token of tokens.toSorted((left, right) => centerY(left) - centerY(right))) {
    const line = lines.at(-1);
    if (line && centerY(token) <= line.bottom) {
      line.tokens.push(token);
      line.bottom = Math.max(line.bottom, token.box.y + token.box.height);
    } else {
      lines.push({ bottom: token.box.y + token.box.height, tokens: [token] });
    }
  }
  return lines.flatMap((line, lineIndex) =>
    line.tokens
      .toSorted((left, right) => left.box.x - right.box.x)
      .map((token) => ({ ...token, lineIndex })),
  );
}

/**
 * Merges OCR tokens into a native text layer.
 *
 * @remarks
 * Every native token is kept because native text is exact. An OCR token is dropped when its center
 * falls inside a native token's box, which happens when a region overlaps native text.
 *
 * @param native - Native tokens of the page
 * @param ocr - OCR tokens in page coordinates
 * @returns The merged tokens and the number of OCR tokens kept
 */
function mergeTokens(
  native: readonly TextToken[],
  ocr: readonly TextToken[],
): { readonly tokens: readonly TextToken[]; readonly ocrCount: number } {
  const kept = ocr.filter((token) => {
    const x = token.box.x + token.box.width / 2;
    const y = centerY(token);
    return !native.some(
      ({ box }) => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height,
    );
  });
  if (kept.length === 0) return { tokens: native, ocrCount: 0 };
  return { tokens: relineTokens([...native, ...kept]), ocrCount: kept.length };
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
   * Returns the configured OCR engine.
   *
   * @returns The OCR engine
   * @throws {@link OcrError} when no OCR engine is configured
   */
  const requireOcr = (): OcrEngine => {
    if (!options.ocr) {
      throw new OcrError("OCR is required by this document but no OCR engine was configured.");
    }
    return options.ocr;
  };

  /**
   * Checks the pixel limit, then renders a page for OCR.
   *
   * @param page - Page to render
   * @param signal - Optional cancellation signal
   * @returns The grayscale page render
   * @throws {@link LimitExceededError} when the render would exceed `maxPixelsPerPage`
   */
  const renderForOcr = async (page: PdfPage, signal?: AbortSignal): Promise<PageBitmap> => {
    const pixels = estimatedPixels(page, OCR_DPI);
    if (pixels > limits.maxPixelsPerPage) {
      throw new LimitExceededError(
        `Page ${page.number} would render ${pixels} pixels, above the configured limit.`,
        "pixels",
        pixels,
        limits.maxPixelsPerPage,
      );
    }
    const bitmap = await page.render({
      dpi: OCR_DPI,
      grayscale: true,
      ...(signal ? { signal } : {}),
    });
    abortIfNeeded(signal);
    return bitmap;
  };

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
    const ocr = requireOcr();
    abortIfNeeded(signal);
    const started = performance.now();
    try {
      const bitmap = await renderForOcr(state.page, signal);
      if (isBlankBitmap(bitmap, signal)) {
        state.ocrSkippedReason = "blank-page";
        state.durationMs += performance.now() - started;
        return;
      }
      const result = await ocr.recognize(bitmap, {
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

  /**
   * Renders a page once, recognizes each declared region, and merges the result with native text.
   *
   * @remarks
   * Blank regions are not sent to the OCR engine. Page confidence is the mean of the regions'
   * confidences.
   *
   * @param state - Page state updated in place
   * @param regions - Normalized regions declared on this page
   * @param profile - Profile providing the OCR languages
   * @param signal - Optional cancellation signal
   * @returns A promise that resolves once the page state is updated
   * @throws {@link OcrError} when no OCR engine is configured or recognition fails
   * @throws {@link LimitExceededError} when the render would exceed `maxPixelsPerPage`
   */
  const runRegionOcr = async (
    state: MutablePageState,
    regions: readonly BoundingBox[],
    profile: DocumentProfile,
    signal?: AbortSignal,
  ): Promise<void> => {
    const ocr = requireOcr();
    abortIfNeeded(signal);
    const started = performance.now();
    try {
      const bitmap = await renderForOcr(state.page, signal);
      const tokens: TextToken[] = [];
      const confidences: number[] = [];
      let recognized = 0;
      for (const region of regions) {
        const crop = cropBitmap(bitmap, region);
        if (!crop || isBlankBitmap(crop.bitmap, signal)) continue;
        const result = await ocr.recognize(crop.bitmap, {
          languages: profile.languages,
          ...(signal ? { signal } : {}),
        });
        recognized += 1;
        tokens.push(...result.tokens.map((token) => toPageToken(token, crop.box)));
        if (result.confidence !== undefined) confidences.push(result.confidence);
      }
      const merged = mergeTokens(state.nativeTokens, tokens);
      state.tokens = merged.tokens;
      if (merged.ocrCount > 0) state.source = state.nativeTokens.length === 0 ? "ocr" : "mixed";
      state.ocrRegionCount = recognized;
      if (confidences.length > 0) {
        state.ocrConfidence = confidences.reduce((sum, item) => sum + item, 0) / confidences.length;
      }
    } catch (cause) {
      if (cause instanceof ScribeError) throw cause;
      throw new OcrError(`OCR failed on page ${state.page.number}.`, { cause });
    } finally {
      state.durationMs += performance.now() - started;
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

        const mode = parseOptions.ocr ?? "auto";
        const regions = profile.ocr?.regions
          ? regionsByPage(profile.ocr.regions, document.pageCount)
          : undefined;
        /**
         * OCRs the declared regions of a page, or the whole page when the profile has no regions.
         *
         * @param state - Page state updated in place
         * @returns A promise that resolves once the page state is updated
         */
        const ocrPage = (state: MutablePageState): Promise<void> => {
          const pageRegions = regions?.get(state.page.number);
          return pageRegions
            ? runRegionOcr(state, pageRegions, profile, parseOptions.signal)
            : runOcr(state, profile, parseOptions.signal);
        };
        /**
         * Tells whether a page may be sent to the OCR engine at all.
         *
         * @param state - Page state
         * @returns `true` without declared regions, or when the page has at least one
         */
        const ocrAllowed = (state: MutablePageState): boolean =>
          !regions || regions.has(state.page.number);

        const pages = await mapConcurrent(
          Array.from({ length: document.pageCount }, (_, index) => index),
          limits.concurrency,
          async (index): Promise<MutablePageState> => {
            abortIfNeeded(parseOptions.signal);
            const page = await document.getPage(index);
            if (mode === "always" && !regions) {
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

        if (mode === "always") {
          await mapConcurrent(pages.filter(ocrAllowed), limits.concurrency, ocrPage);
        }

        let extraction: ProfileExtraction = await extractProfile(profile, asExtractPages(pages));
        if (mode === "auto") {
          const ocrPages = new Set<number>(extraction.implicatedPages);
          for (const state of pages) {
            if (nativeCharacterCount(state.nativeTokens) < MIN_NATIVE_CHARACTERS) {
              ocrPages.add(state.page.number);
            }
          }
          const targets = pages.filter(
            (state) => ocrPages.has(state.page.number) && ocrAllowed(state),
          );
          if (targets.length > 0 && options.ocr) {
            await mapConcurrent(targets, limits.concurrency, ocrPage);
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
        if (mode === "auto" && pages.some((state) => state.source !== "native")) {
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
