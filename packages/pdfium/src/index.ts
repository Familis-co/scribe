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

  /** {@inheritDoc @familis/scribe#PdfPage.render} */
  async render(options: PdfRenderOptions): Promise<PageBitmap> {
    this.#assertOpen();
    abortIfNeeded(options.signal);
    const width = Math.max(1, Math.ceil((this.width * options.dpi) / 72));
    const height = Math.max(1, Math.ceil((this.height * options.dpi) / 72));
    const bitmap = this.module.FPDFBitmap_Create(width, height, 1);
    if (!bitmap)
      throw new PdfEngineError(`PDFium could not allocate a bitmap for page ${this.number}.`);
    try {
      this.module.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
      this.module.FPDF_RenderPageBitmap(bitmap, this.pagePointer, 0, 0, width, height, 0, 0);
      abortIfNeeded(options.signal);
      const pointer = this.module.FPDFBitmap_GetBuffer(bitmap);
      const stride = this.module.FPDFBitmap_GetStride(bitmap);
      const source = heap(this.module).subarray(pointer, pointer + stride * height);

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
        return { data: rgba, width, height, format: "rgba8", dpi: options.dpi };
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
      return { data: gray, width, height, format: "gray8", dpi: options.dpi };
    } finally {
      this.module.FPDFBitmap_Destroy(bitmap);
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
