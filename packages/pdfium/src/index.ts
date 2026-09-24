/**
 * PDFium WebAssembly adapter for positioned native PDF text extraction and page rendering.
 *
 * @packageDocumentation
 */
import { init, type PdfiumModule, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import {
  AbortError,
  DisposedError,
  EncryptedPdfError,
  InvalidPdfError,
  PdfEngineError,
  type BoundingBox,
  type PageBitmap,
  type PageRule,
  type PageRules,
  type PdfPageImage,
  type PdfDocument,
  type PdfEngine,
  type PdfOpenOptions,
  type PdfPage,
  type PdfRenderOptions,
  type TextToken,
} from "@familis/scribe";

/** `FPDF_ERR_PASSWORD`, returned by `FPDF_GetLastError` for missing or wrong passwords. */
const PDFIUM_ERROR_PASSWORD = 4;
/** PDFium bitmaps use four bytes per pixel in BGRA order. */
const BYTES_PER_PIXEL = 4;
/** `FPDF_PAGEOBJ_PATH`, the page object type of vector paths. */
const PAGE_OBJECT_PATH = 2;
/** `FPDF_PAGEOBJ_IMAGE`, the page object type of raster images. */
const PAGE_OBJECT_IMAGE = 3;
/** Bytes per pixel of each `FPDFBitmap_*` format, by format number: gray, BGR, BGRx and BGRA. */
const FORMAT_BYTES: Readonly<Record<number, number>> = { 1: 1, 2: 3, 3: 4, 4: 4 };
/** `FPDFBitmap_BGRA`, the only bitmap format whose fourth byte is alpha. */
const FORMAT_BGRA = 4;
/** Largest matrix skew, relative to its scale, of an image still read as upright. */
const SKEW_TOLERANCE = 1e-3;
/** `FPDF_SEGMENT_LINETO`, a straight path segment. */
const SEGMENT_LINE = 0;
/** `FPDF_SEGMENT_MOVETO`, the start of a subpath. */
const SEGMENT_MOVE = 2;
/** Thickest filled box, in PDF points, still read as a rule. */
const MAX_RULE_THICKNESS = 3;
/** Shortest line, in PDF points, read as a rule rather than a tick or a glyph detail. */
const MIN_RULE_LENGTH = 6;
/** Largest deviation, in PDF points, of a segment still read as vertical or horizontal. */
const AXIS_TOLERANCE = 0.5;

/**
 * Returns the Emscripten heap backing a PDFium module.
 *
 * @param module - Initialized PDFium module
 * @returns The module's linear memory as bytes
 */
function heap(module: WrappedPdfiumModule): Uint8Array {
  // The Emscripten heap exists at runtime but is intentionally omitted from the public type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (module.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
}

/** Advanced PDFium WebAssembly initialization options. */
export interface PdfiumEngineOptions {
  /**
   * Overrides forwarded to the `@embedpdf/pdfium` Emscripten module.
   *
   * @remarks
   * Most Node.js and Bun applications should omit this value.
   */
  readonly moduleOverrides?: Partial<PdfiumModule>;
}

/** One character read from PDFium with its normalized box. */
interface PositionedCharacter {
  readonly text: string;
  readonly box: BoundingBox;
}

/**
 * Throws when a cancellation signal has already fired.
 *
 * @param signal - Optional cancellation signal
 * @throws `AbortError` when the signal is aborted, with its reason as `cause`
 */
function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new AbortError("The PDF operation was aborted.", { cause: signal.reason });
}

/**
 * Clamps a value to the normalized `[0, 1]` range.
 *
 * @param value - Number to clamp
 * @returns The clamped value
 */
const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Computes the smallest rectangle enclosing every box.
 *
 * @param boxes - Non-empty list of rectangles
 * @returns The enclosing rectangle
 */
function unionBoxes(boxes: readonly BoundingBox[]): BoundingBox {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** A straight segment in page space, in PDF points with a bottom-left origin. */
interface Segment {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * Converts an axis-aligned segment into a normalized rule.
 *
 * @param segment - Segment in PDF points
 * @param width - Page width in PDF points
 * @param height - Page height in PDF points
 * @returns The rule and its direction, or `undefined` for a short or slanted segment
 */
function ruleOf(
  segment: Segment,
  width: number,
  height: number,
): { readonly vertical: boolean; readonly rule: PageRule } | undefined {
  const dx = Math.abs(segment.x1 - segment.x0);
  const dy = Math.abs(segment.y1 - segment.y0);
  if (dx <= AXIS_TOLERANCE && dy >= MIN_RULE_LENGTH) {
    return {
      vertical: true,
      rule: {
        position: clamp((segment.x0 + segment.x1) / 2 / width),
        start: clamp(1 - Math.max(segment.y0, segment.y1) / height),
        end: clamp(1 - Math.min(segment.y0, segment.y1) / height),
      },
    };
  }
  if (dy <= AXIS_TOLERANCE && dx >= MIN_RULE_LENGTH) {
    return {
      vertical: false,
      rule: {
        position: clamp(1 - (segment.y0 + segment.y1) / 2 / height),
        start: clamp(Math.min(segment.x0, segment.x1) / width),
        end: clamp(Math.max(segment.x0, segment.x1) / width),
      },
    };
  }
  return undefined;
}

/**
 * Groups positioned characters into word tokens.
 *
 * @remarks
 * Whitespace always ends a word, and line breaks advance the line index. Without whitespace, a
 * vertical center shift above 65% of the glyph height starts a new line, and a horizontal gap
 * wider than 1.8 glyph widths (at least 0.6% of the page) starts a new word.
 *
 * @param characters - Characters in PDFium text order
 * @returns Non-empty word tokens with line indices
 */
function groupCharacters(characters: readonly PositionedCharacter[]): readonly TextToken[] {
  const tokens: TextToken[] = [];
  let word: PositionedCharacter[] = [];
  let lineIndex = 0;
  let previous: PositionedCharacter | undefined;

  /** Emits the pending characters as one token and starts a new word. */
  const flush = (): void => {
    if (word.length === 0) return;
    tokens.push({
      text: word.map((character) => character.text).join(""),
      box: unionBoxes(word.map((character) => character.box)),
      source: "native",
      lineIndex,
    });
    word = [];
  };

  for (const character of characters) {
    if (/\s/u.test(character.text)) {
      flush();
      if (/[\r\n]/u.test(character.text)) lineIndex += 1;
      previous = undefined;
      continue;
    }

    if (previous) {
      const previousCenter = previous.box.y + previous.box.height / 2;
      const currentCenter = character.box.y + character.box.height / 2;
      const lineThreshold = Math.max(previous.box.height, character.box.height) * 0.65;
      const gap = character.box.x - (previous.box.x + previous.box.width);
      const wordThreshold = Math.max(previous.box.width * 1.8, 0.006);
      if (Math.abs(currentCenter - previousCenter) > lineThreshold) {
        flush();
        lineIndex += 1;
      } else if (gap > wordThreshold) {
        flush();
      }
    }
    word.push(character);
    previous = character;
  }
  flush();
  return tokens.filter((token) => token.text.trim() !== "");
}

/** PDFium-backed page whose native handle is released by {@link PdfiumPage.close}. */
class PdfiumPage implements PdfPage {
  readonly number: number;
  readonly width: number;
  readonly height: number;
  #closed = false;

  /**
   * Wraps a loaded PDFium page.
   *
   * @param module - Initialized PDFium module owning the page
   * @param pagePointer - Native `FPDF_PAGE` handle
   * @param index - Zero-based page index
   */
  constructor(
    private readonly module: WrappedPdfiumModule,
    private readonly pagePointer: number,
    readonly index: number,
  ) {
    this.number = index + 1;
    this.width = module.FPDF_GetPageWidthF(pagePointer);
    this.height = module.FPDF_GetPageHeightF(pagePointer);
  }

  /** {@inheritDoc @familis/scribe#PdfPage.extractText} */
  async extractText(signal?: AbortSignal): Promise<readonly TextToken[]> {
    this.#assertOpen();
    abortIfNeeded(signal);
    const textPage = this.module.FPDFText_LoadPage(this.pagePointer);
    if (!textPage) throw new PdfEngineError(`PDFium could not load text for page ${this.number}.`);
    const boxPointer = this.module.pdfium.wasmExports.malloc(4 * Float64Array.BYTES_PER_ELEMENT);
    try {
      const count = this.module.FPDFText_CountChars(textPage);
      const characters: PositionedCharacter[] = [];
      for (let index = 0; index < count; index += 1) {
        if (index % 256 === 0) abortIfNeeded(signal);
        const codePoint = this.module.FPDFText_GetUnicode(textPage, index);
        if (codePoint <= 0 || codePoint > 0x10ffff) continue;
        const found = this.module.FPDFText_GetCharBox(
          textPage,
          index,
          boxPointer,
          boxPointer + 8,
          boxPointer + 16,
          boxPointer + 24,
        );
        if (!found) continue;
        const left = Number(this.module.pdfium.getValue(boxPointer, "double"));
        const right = Number(this.module.pdfium.getValue(boxPointer + 8, "double"));
        const bottom = Number(this.module.pdfium.getValue(boxPointer + 16, "double"));
        const top = Number(this.module.pdfium.getValue(boxPointer + 24, "double"));
        const box = {
          x: clamp(left / this.width),
          y: clamp(1 - top / this.height),
          width: clamp((right - left) / this.width),
          height: clamp((top - bottom) / this.height),
        };
        characters.push({ text: String.fromCodePoint(codePoint), box });
      }
      return groupCharacters(characters);
    } finally {
      this.module.pdfium.wasmExports.free(boxPointer);
      this.module.FPDFText_ClosePage(textPage);
    }
  }

  /** {@inheritDoc @familis/scribe#PdfPage.rules} */
  async rules(signal?: AbortSignal): Promise<PageRules> {
    this.#assertOpen();
    abortIfNeeded(signal);
    // Every straight, axis-aligned segment of a stroked path is a rule, which covers lines, stroked
    // rectangles and grids drawn as one path. A filled path is a rule when its bounds are a thin,
    // long box. Paths nested in form XObjects are not read.
    const vertical: PageRule[] = [];
    const horizontal: PageRule[] = [];
    /**
     * Records a segment when it is a rule.
     *
     * @param segment - Segment in page space
     */
    const add = (segment: Segment): void => {
      const found = ruleOf(segment, this.width, this.height);
      if (found) (found.vertical ? vertical : horizontal).push(found.rule);
    };
    const scratch = this.module.pdfium.wasmExports.malloc(6 * Float32Array.BYTES_PER_ELEMENT);
    /**
     * Reads a 32-bit float written by PDFium into the scratch buffer.
     *
     * @param index - Float index within the scratch buffer
     * @returns The float value
     */
    const float = (index: number): number =>
      Number(this.module.pdfium.getValue(scratch + index * 4, "float"));
    try {
      const count = this.module.FPDFPage_CountObjects(this.pagePointer);
      for (let index = 0; index < count; index += 1) {
        if (index % 256 === 0) abortIfNeeded(signal);
        const object = this.module.FPDFPage_GetObject(this.pagePointer, index);
        if (!object || this.module.FPDFPageObj_GetType(object) !== PAGE_OBJECT_PATH) continue;
        if (!this.module.FPDFPath_GetDrawMode(object, scratch, scratch + 4)) continue;
        const stroked = this.module.pdfium.getValue(scratch + 4, "i32") !== 0;
        const filled = this.module.pdfium.getValue(scratch, "i32") !== 0;

        if (!stroked) {
          const bounded =
            filled &&
            this.module.FPDFPageObj_GetBounds(
              object,
              scratch,
              scratch + 4,
              scratch + 8,
              scratch + 12,
            );
          if (!bounded) continue;
          const [left, bottom, right, top] = [float(0), float(1), float(2), float(3)];
          if (right - left <= MAX_RULE_THICKNESS && top - bottom > (right - left) * 3) {
            add({ x0: (left + right) / 2, y0: bottom, x1: (left + right) / 2, y1: top });
          } else if (top - bottom <= MAX_RULE_THICKNESS && right - left > (top - bottom) * 3) {
            add({ x0: left, y0: (bottom + top) / 2, x1: right, y1: (bottom + top) / 2 });
          }
          continue;
        }

        if (!this.module.FPDFPageObj_GetMatrix(object, scratch)) continue;
        const [a, b, c, d, e, f] = [float(0), float(1), float(2), float(3), float(4), float(5)];
        /**
         * Maps a path point to page space with the object's matrix.
         *
         * @param x - Horizontal path coordinate
         * @param y - Vertical path coordinate
         * @returns The point in PDF points
         */
        const toPage = (x: number, y: number): { x: number; y: number } => ({
          x: a * x + c * y + e,
          y: b * x + d * y + f,
        });
        let current: { x: number; y: number } | undefined;
        let subpathStart: { x: number; y: number } | undefined;
        const segments = this.module.FPDFPath_CountSegments(object);
        for (let segmentIndex = 0; segmentIndex < segments; segmentIndex += 1) {
          const segment = this.module.FPDFPath_GetPathSegment(object, segmentIndex);
          if (!segment || !this.module.FPDFPathSegment_GetPoint(segment, scratch, scratch + 4)) {
            continue;
          }
          const point = toPage(float(0), float(1));
          const type = this.module.FPDFPathSegment_GetType(segment);
          if (type === SEGMENT_MOVE) {
            subpathStart = point;
          } else if (type === SEGMENT_LINE && current) {
            add({ x0: current.x, y0: current.y, x1: point.x, y1: point.y });
          }
          current = point;
          if (this.module.FPDFPathSegment_GetClose(segment) && subpathStart) {
            add({ x0: point.x, y0: point.y, x1: subpathStart.x, y1: subpathStart.y });
            current = subpathStart;
          }
        }
      }
    } finally {
      this.module.pdfium.wasmExports.free(scratch);
    }
    return {
      vertical: vertical.toSorted((left, right) => left.position - right.position),
      horizontal: horizontal.toSorted((left, right) => left.position - right.position),
    };
  }

  /**
   * {@inheritDoc @familis/scribe#PdfPage.render}
   *
   * @throws `PdfEngineError` when PDFium cannot allocate the bitmap
   */
  async render(options: PdfRenderOptions): Promise<PageBitmap> {
    this.#assertOpen();
    abortIfNeeded(options.signal);
    const fullWidth = Math.max(1, Math.ceil((this.width * options.dpi) / 72));
    const fullHeight = Math.max(1, Math.ceil((this.height * options.dpi) / 72));
    const { clip } = options;
    const left = clip ? Math.max(0, Math.floor(clip.x * fullWidth + 1e-6)) : 0;
    const top = clip ? Math.max(0, Math.floor(clip.y * fullHeight + 1e-6)) : 0;
    const right = clip
      ? Math.min(fullWidth, Math.ceil((clip.x + clip.width) * fullWidth - 1e-6))
      : fullWidth;
    const bottom = clip
      ? Math.min(fullHeight, Math.ceil((clip.y + clip.height) * fullHeight - 1e-6))
      : fullHeight;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const bitmap = this.module.FPDFBitmap_Create(width, height, 1);
    if (!bitmap)
      throw new PdfEngineError(`PDFium could not allocate a bitmap for page ${this.number}.`);
    try {
      this.module.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
      if (clip) {
        this.#renderClipped(bitmap, fullWidth, fullHeight, left, top, width, height);
      } else {
        this.module.FPDF_RenderPageBitmap(bitmap, this.pagePointer, 0, 0, width, height, 0, 0);
      }
      abortIfNeeded(options.signal);
      const pointer = this.module.FPDFBitmap_GetBuffer(bitmap);
      const stride = this.module.FPDFBitmap_GetStride(bitmap);
      const source = heap(this.module).subarray(pointer, pointer + stride * height);
      const area = clip
        ? {
            box: {
              x: left / fullWidth,
              y: top / fullHeight,
              width: width / fullWidth,
              height: height / fullHeight,
            },
          }
        : {};

      if (!options.grayscale) {
        const rgba = new Uint8Array(width * height * BYTES_PER_PIXEL);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const sourceIndex = y * stride + x * BYTES_PER_PIXEL;
            const targetIndex = (y * width + x) * BYTES_PER_PIXEL;
            rgba[targetIndex] = source[sourceIndex + 2]!;
            rgba[targetIndex + 1] = source[sourceIndex + 1]!;
            rgba[targetIndex + 2] = source[sourceIndex]!;
            rgba[targetIndex + 3] = source[sourceIndex + 3]!;
          }
        }
        return { data: rgba, width, height, format: "rgba8", dpi: options.dpi, ...area };
      }

      const gray = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const sourceIndex = y * stride + x * BYTES_PER_PIXEL;
          const blue = source[sourceIndex]!;
          const green = source[sourceIndex + 1]!;
          const red = source[sourceIndex + 2]!;
          gray[y * width + x] = Math.round(0.114 * blue + 0.587 * green + 0.299 * red);
        }
      }
      return { data: gray, width, height, format: "gray8", dpi: options.dpi, ...area };
    } finally {
      this.module.FPDFBitmap_Destroy(bitmap);
    }
  }

  /**
   * {@inheritDoc @familis/scribe#PdfPage.images}
   *
   * @throws `PdfEngineError` when PDFium cannot read the page's objects
   */
  async images(signal?: AbortSignal): Promise<readonly PdfPageImage[]> {
    this.#assertOpen();
    abortIfNeeded(signal);
    // Only upright images are returned: their native pixel rows run top to bottom on the page. A
    // rotated, skewed or flipped image is left to the rendered fallback.
    const images: PdfPageImage[] = [];
    const scratch = this.module.pdfium.wasmExports.malloc(6 * Float32Array.BYTES_PER_ELEMENT);
    /**
     * Reads a 32-bit float written by PDFium into the scratch buffer.
     *
     * @param index - Float index within the scratch buffer
     * @returns The float value
     */
    const float = (index: number): number =>
      Number(this.module.pdfium.getValue(scratch + index * 4, "float"));
    try {
      const count = this.module.FPDFPage_CountObjects(this.pagePointer);
      for (let index = 0; index < count; index += 1) {
        abortIfNeeded(signal);
        const object = this.module.FPDFPage_GetObject(this.pagePointer, index);
        if (!object || this.module.FPDFPageObj_GetType(object) !== PAGE_OBJECT_IMAGE) continue;
        if (!this.module.FPDFPageObj_GetMatrix(object, scratch)) continue;
        const [a, b, c, d] = [float(0), float(1), float(2), float(3)];
        if (
          a <= 0 ||
          d <= 0 ||
          Math.abs(b) > a * SKEW_TOLERANCE ||
          Math.abs(c) > d * SKEW_TOLERANCE
        ) {
          continue;
        }
        if (
          !this.module.FPDFPageObj_GetBounds(
            object,
            scratch,
            scratch + 4,
            scratch + 8,
            scratch + 12,
          )
        ) {
          continue;
        }
        const [left, bottom, right, top] = [float(0), float(1), float(2), float(3)];
        const bitmap = this.#imageBitmap(object);
        if (!bitmap || right <= left) continue;
        images.push({
          box: {
            x: clamp(left / this.width),
            y: clamp(1 - top / this.height),
            width: clamp((right - left) / this.width),
            height: clamp((top - bottom) / this.height),
          },
          bitmap: { ...bitmap, dpi: (bitmap.width * 72) / (right - left) },
        });
      }
    } finally {
      this.module.pdfium.wasmExports.free(scratch);
    }
    return images;
  }

  /**
   * Decodes an image object's native pixels to grayscale.
   *
   * @param object - Native `FPDF_PAGEOBJECT` image handle
   * @returns The grayscale pixels, or `undefined` when PDFium cannot decode the image
   */
  #imageBitmap(object: number): PageBitmap | undefined {
    const bitmap = this.module.FPDFImageObj_GetBitmap(object);
    if (!bitmap) return undefined;
    try {
      const width = this.module.FPDFBitmap_GetWidth(bitmap);
      const height = this.module.FPDFBitmap_GetHeight(bitmap);
      const format = this.module.FPDFBitmap_GetFormat(bitmap);
      const bytes = FORMAT_BYTES[format];
      if (!bytes || width <= 0 || height <= 0) return undefined;
      const pointer = this.module.FPDFBitmap_GetBuffer(bitmap);
      const stride = this.module.FPDFBitmap_GetStride(bitmap);
      const source = heap(this.module).subarray(pointer, pointer + stride * height);
      const gray = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const sourceIndex = y * stride + x * bytes;
          if (bytes === 1) {
            gray[y * width + x] = source[sourceIndex]!;
            continue;
          }
          const luminance =
            0.114 * source[sourceIndex]! +
            0.587 * source[sourceIndex + 1]! +
            0.299 * source[sourceIndex + 2]!;
          // Transparent pixels are composited over white, as the page renders them.
          const alpha = format === FORMAT_BGRA ? source[sourceIndex + 3]! / 255 : 1;
          gray[y * width + x] = Math.round(255 - (255 - luminance) * alpha);
        }
      }
      return { data: gray, width, height, format: "gray8" };
    } finally {
      this.module.FPDFBitmap_Destroy(bitmap);
    }
  }

  /**
   * Renders a rectangle of the full-page raster into a bitmap of that rectangle's size.
   *
   * @param bitmap - Native bitmap sized to the rectangle
   * @param fullWidth - Width of the full-page raster in pixels
   * @param fullHeight - Height of the full-page raster in pixels
   * @param left - Left edge of the rectangle in full-page pixels
   * @param top - Top edge of the rectangle in full-page pixels
   * @param width - Rectangle width in pixels
   * @param height - Rectangle height in pixels
   */
  #renderClipped(
    bitmap: number,
    fullWidth: number,
    fullHeight: number,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    // FS_MATRIX { a, b, c, d, e, f } followed by FS_RECTF { left, top, right, bottom }.
    const pointer = this.module.pdfium.wasmExports.malloc(10 * Float32Array.BYTES_PER_ELEMENT);
    try {
      // The matrix applies after the page's own display transform, which maps the page to a
      // top-left-origin rectangle one pixel per point; scaling it to the full raster and shifting
      // by the rectangle's corner lands the rectangle on the bitmap's origin.
      const values = [
        fullWidth / this.width,
        0,
        0,
        fullHeight / this.height,
        -left,
        -top,
        0,
        0,
        width,
        height,
      ];
      values.forEach((value, index) =>
        this.module.pdfium.setValue(pointer + index * 4, value, "float"),
      );
      this.module.FPDF_RenderPageBitmapWithMatrix(
        bitmap,
        this.pagePointer,
        pointer,
        pointer + 24,
        0,
      );
    } finally {
      this.module.pdfium.wasmExports.free(pointer);
    }
  }

  /** Releases the native page handle. Repeated calls are ignored. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.module.FPDF_ClosePage(this.pagePointer);
  }

  /**
   * Guards against use after {@link PdfiumPage.close}.
   *
   * @throws `DisposedError` when the page is closed
   */
  #assertOpen(): void {
    if (this.#closed) throw new DisposedError();
  }
}

/** PDFium-backed document that caches loaded pages and owns its input buffer. */
class PdfiumDocument implements PdfDocument {
  readonly pageCount: number;
  readonly #pages = new Map<number, PdfiumPage>();
  #closed = false;

  /**
   * Wraps a loaded PDFium document.
   *
   * @param module - Initialized PDFium module owning the document
   * @param documentPointer - Native `FPDF_DOCUMENT` handle
   * @param inputPointer - Heap address of the PDF bytes, freed on close
   */
  constructor(
    private readonly module: WrappedPdfiumModule,
    private readonly documentPointer: number,
    private readonly inputPointer: number,
  ) {
    this.pageCount = module.FPDF_GetPageCount(documentPointer);
  }

  /**
   * {@inheritDoc @familis/scribe#PdfDocument.getPage}
   *
   * @throws `RangeError` when the index is outside the document
   */
  async getPage(index: number): Promise<PdfPage> {
    this.#assertOpen();
    if (!Number.isInteger(index) || index < 0 || index >= this.pageCount) {
      throw new RangeError(`Page index ${index} is outside this document.`);
    }
    const cached = this.#pages.get(index);
    if (cached) return cached;
    const pointer = this.module.FPDF_LoadPage(this.documentPointer, index);
    if (!pointer) throw new PdfEngineError(`PDFium could not load page ${index + 1}.`);
    const page = new PdfiumPage(this.module, pointer, index);
    this.#pages.set(index, page);
    return page;
  }

  /** {@inheritDoc @familis/scribe#PdfDocument.close} */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const page of this.#pages.values()) page.close();
    this.#pages.clear();
    this.module.FPDF_CloseDocument(this.documentPointer);
    this.module.pdfium.wasmExports.free(this.inputPointer);
  }

  /**
   * Guards against use after {@link PdfiumDocument.close}.
   *
   * @throws `DisposedError` when the document is closed
   */
  #assertOpen(): void {
    if (this.#closed) throw new DisposedError();
  }
}

/** PDFium-backed engine that tracks open documents so it can close them on shutdown. */
class PdfiumEngine implements PdfEngine {
  #closed = false;
  readonly #documents = new Set<PdfiumDocument>();

  /**
   * Wraps an initialized PDFium module.
   *
   * @param module - PDFium module dedicated to this engine
   */
  constructor(private readonly module: WrappedPdfiumModule) {}

  /**
   * {@inheritDoc @familis/scribe#PdfEngine.open}
   *
   * @throws `EncryptedPdfError` when the password is missing or invalid
   * @throws `InvalidPdfError` when PDFium rejects the document
   */
  async open(input: Uint8Array, options: PdfOpenOptions = {}): Promise<PdfDocument> {
    if (this.#closed) throw new DisposedError();
    abortIfNeeded(options.signal);
    const pointer = this.module.pdfium.wasmExports.malloc(input.byteLength);
    heap(this.module).set(input, pointer);
    const documentPointer = this.module.FPDF_LoadMemDocument64(
      pointer,
      input.byteLength,
      options.password ?? "",
    );
    if (!documentPointer) {
      const error = this.module.FPDF_GetLastError();
      this.module.pdfium.wasmExports.free(pointer);
      if (error === PDFIUM_ERROR_PASSWORD) {
        throw new EncryptedPdfError("The PDF password is missing or invalid.");
      }
      throw new InvalidPdfError(`PDFium rejected the document with error code ${error}.`);
    }
    const document = new PdfiumDocument(this.module, documentPointer, pointer);
    this.#documents.add(document);
    const close = document.close.bind(document);
    document.close = async () => {
      await close();
      this.#documents.delete(document);
    };
    return document;
  }

  /** {@inheritDoc @familis/scribe#PdfEngine.close} */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#documents].map((document) => document.close()));
    this.#documents.clear();
    this.module.FPDF_DestroyLibrary();
  }
}

/**
 * Initializes PDFium and creates a reusable PDF engine.
 *
 * @param options - Optional Emscripten module overrides
 * @returns A PDF engine backed by a dedicated PDFium WebAssembly module
 *
 * @remarks
 * Reuse the engine across documents and call {@link PdfEngine.close} during application shutdown.
 * The adapter resolves the PDFium WASM asset locally from `@embedpdf/pdfium`.
 *
 * @example
 * ```ts
 * const engine = await createPdfiumEngine();
 * try {
 *   const document = await engine.open(pdfBytes);
 * } finally {
 *   await engine.close();
 * }
 * ```
 *
 * @public
 */
export async function createPdfiumEngine(options: PdfiumEngineOptions = {}): Promise<PdfEngine> {
  const module = await init(options.moduleOverrides ?? {});
  module.PDFiumExt_Init();
  return new PdfiumEngine(module);
}
