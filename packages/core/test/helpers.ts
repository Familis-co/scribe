import type {
  BoundingBox,
  OcrEngine,
  OcrResult,
  PageBitmap,
  PageRules,
  PdfDocument,
  PdfEngine,
  PdfOpenOptions,
  PdfPage,
  PdfPageImage,
  PdfRenderOptions,
  TextToken,
} from "../src/index.js";

/**
 * Builds a normalized bounding box with a typical word size by default.
 *
 * @param x - Horizontal position between `0` and `1`
 * @param y - Vertical position between `0` and `1`
 * @param width - Relative width
 * @param height - Relative height
 * @returns The bounding box
 */
export const box = (x: number, y: number, width = 0.1, height = 0.03): BoundingBox => ({
  x,
  y,
  width,
  height,
});

/**
 * Builds a positioned text token.
 *
 * @param text - Token text
 * @param value - Normalized token box
 * @param lineIndex - Line grouping index within the page
 * @param source - Extraction method, which controls whether `confidence` is set
 * @param confidence - OCR confidence, only applied to `ocr` tokens
 * @returns The text token
 */
export const token = (
  text: string,
  value: BoundingBox,
  lineIndex = 0,
  source: "native" | "ocr" = "native",
  confidence = 0.95,
): TextToken => ({
  text,
  box: value,
  source,
  lineIndex,
  ...(source === "ocr" ? { confidence } : {}),
});

/** Optional capabilities of the pages served by {@link MockPdfEngine}. */
export interface MockPageFeatures {
  /** Embedded images returned by `images()` for each page, by index. The method is omitted otherwise. */
  readonly images?: readonly (readonly PdfPageImage[] | undefined)[];
  /** Whether renders honor `clip`, returning black pixels of the clipped area with its `box`. */
  readonly clipping?: boolean;
}

/** US Letter page returning fixed native tokens and counting renders. */
class MockPage implements PdfPage {
  readonly width = 612;
  readonly height = 792;
  readonly number: number;
  renderCount = 0;
  rulesCount = 0;
  readonly renders: PdfRenderOptions[] = [];
  readonly rules?: () => Promise<PageRules>;
  readonly images?: () => Promise<readonly PdfPageImage[]>;

  /**
   * Creates a mock page.
   *
   * @param index - Zero-based page index
   * @param nativeTokens - Tokens returned by {@link MockPage.extractText}
   * @param bitmap - Bitmap returned by {@link MockPage.render}, a blank 10x10 image when omitted
   * @param rules - Rules returned by `rules()`, which is left undefined when omitted
   * @param images - Images returned by `images()`, which is left undefined when omitted
   * @param clipping - Whether renders honor `clip`
   */
  constructor(
    readonly index: number,
    private readonly nativeTokens: readonly TextToken[],
    private readonly bitmap?: PageBitmap,
    rules?: PageRules,
    images?: readonly PdfPageImage[],
    private readonly clipping = false,
  ) {
    this.number = index + 1;
    if (rules) {
      this.rules = async () => {
        this.rulesCount += 1;
        return rules;
      };
    }
    if (images) this.images = async () => images;
  }

  /**
   * Returns the configured native tokens.
   *
   * @returns The native tokens passed to the constructor
   */
  async extractText(): Promise<readonly TextToken[]> {
    return this.nativeTokens;
  }

  /**
   * Returns the configured bitmap, or a clipped black render, and records the call.
   *
   * @param options - Render options, whose `dpi` is echoed on the default bitmap
   * @returns The clipped render when clipping is enabled, else the configured or default bitmap
   */
  async render(options: PdfRenderOptions): Promise<PageBitmap> {
    this.renderCount += 1;
    this.renders.push(options);
    if (this.clipping && options.clip) {
      const fullWidth = Math.ceil((this.width * options.dpi) / 72);
      const fullHeight = Math.ceil((this.height * options.dpi) / 72);
      const left = Math.floor(options.clip.x * fullWidth + 1e-6);
      const top = Math.floor(options.clip.y * fullHeight + 1e-6);
      const right = Math.ceil((options.clip.x + options.clip.width) * fullWidth - 1e-6);
      const bottom = Math.ceil((options.clip.y + options.clip.height) * fullHeight - 1e-6);
      return {
        data: new Uint8Array((right - left) * (bottom - top)),
        width: right - left,
        height: bottom - top,
        format: "gray8",
        dpi: options.dpi,
        box: {
          x: left / fullWidth,
          y: top / fullHeight,
          width: (right - left) / fullWidth,
          height: (bottom - top) / fullHeight,
        },
      };
    }
    return (
      this.bitmap ?? {
        data: new Uint8Array(100),
        width: 10,
        height: 10,
        format: "gray8",
        dpi: options.dpi,
      }
    );
  }
}

/** Document serving pre-built mock pages and counting closes. */
class MockDocument implements PdfDocument {
  readonly pageCount: number;
  closeCount = 0;

  /**
   * Creates a mock document.
   *
   * @param pages - Pages in document order
   */
  constructor(readonly pages: readonly MockPage[]) {
    this.pageCount = pages.length;
  }

  /**
   * Returns a pre-built page.
   *
   * @param index - Zero-based page index
   * @returns The page at that index
   */
  async getPage(index: number): Promise<PdfPage> {
    return this.pages[index]!;
  }

  /** Records the call by incrementing `closeCount`. */
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** PDF engine that always opens the same mock document and counts closes. */
export class MockPdfEngine implements PdfEngine {
  readonly document: MockDocument;
  closeCount = 0;

  /**
   * Creates a mock PDF engine.
   *
   * @param pages - Native tokens for each page, in page order
   * @param bitmaps - Optional render output for each page, by index
   * @param rules - Optional page rules for each page, by index
   * @param features - Optional embedded images and clip support
   */
  constructor(
    pages: readonly (readonly TextToken[])[],
    bitmaps: readonly (PageBitmap | undefined)[] = [],
    rules: readonly (PageRules | undefined)[] = [],
    features: MockPageFeatures = {},
  ) {
    this.document = new MockDocument(
      pages.map(
        (tokens, index) =>
          new MockPage(
            index,
            tokens,
            bitmaps[index],
            rules[index],
            features.images?.[index],
            features.clipping,
          ),
      ),
    );
  }

  /**
   * Returns the mock document regardless of input.
   *
   * @param _input - Ignored PDF bytes
   * @param _options - Ignored open options
   * @returns The shared mock document
   */
  async open(_input: Uint8Array, _options?: PdfOpenOptions): Promise<PdfDocument> {
    return this.document;
  }

  /** Records the call by incrementing `closeCount`. */
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** OCR engine returning scripted results in call order. */
export class MockOcrEngine implements OcrEngine {
  recognizeCount = 0;
  closeCount = 0;
  readonly bitmaps: PageBitmap[] = [];

  /**
   * Creates a mock OCR engine.
   *
   * @param results - Results returned by successive {@link MockOcrEngine.recognize} calls
   */
  constructor(private readonly results: readonly OcrResult[]) {}

  /**
   * Records the bitmap and returns the next scripted result.
   *
   * @param bitmap - Bitmap to recognize, appended to {@link MockOcrEngine.bitmaps}
   * @returns The result matching the current call count
   * @throws `Error` when more calls are made than results were scripted
   */
  async recognize(bitmap: PageBitmap): Promise<OcrResult> {
    this.bitmaps.push(bitmap);
    const result = this.results[this.recognizeCount];
    this.recognizeCount += 1;
    if (!result) throw new Error("Missing mocked OCR result");
    return result;
  }

  /** Records the call by incrementing `closeCount`. */
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}
