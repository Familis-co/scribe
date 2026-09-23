import type {
  BoundingBox,
  OcrEngine,
  OcrResult,
  PageBitmap,
  PdfDocument,
  PdfEngine,
  PdfOpenOptions,
  PdfPage,
  PdfRenderOptions,
  TextToken,
} from "../src/index.js";

export const box = (x: number, y: number, width = 0.1, height = 0.03): BoundingBox => ({
  x,
  y,
  width,
  height,
});

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

class MockPage implements PdfPage {
  readonly width = 612;
  readonly height = 792;
  readonly number: number;
  renderCount = 0;

  constructor(
    readonly index: number,
    private readonly nativeTokens: readonly TextToken[],
    private readonly bitmap?: PageBitmap,
  ) {
    this.number = index + 1;
  }

  async extractText(): Promise<readonly TextToken[]> {
    return this.nativeTokens;
  }

  async render(options: PdfRenderOptions): Promise<PageBitmap> {
    this.renderCount += 1;
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

class MockDocument implements PdfDocument {
  readonly pageCount: number;
  closeCount = 0;

  constructor(readonly pages: readonly MockPage[]) {
    this.pageCount = pages.length;
  }

  async getPage(index: number): Promise<PdfPage> {
    return this.pages[index]!;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

export class MockPdfEngine implements PdfEngine {
  readonly document: MockDocument;
  closeCount = 0;

  constructor(
    pages: readonly (readonly TextToken[])[],
    bitmaps: readonly (PageBitmap | undefined)[] = [],
  ) {
    this.document = new MockDocument(
      pages.map((tokens, index) => new MockPage(index, tokens, bitmaps[index])),
    );
  }

  async open(_input: Uint8Array, _options?: PdfOpenOptions): Promise<PdfDocument> {
    return this.document;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

export class MockOcrEngine implements OcrEngine {
  recognizeCount = 0;
  closeCount = 0;

  constructor(private readonly results: readonly OcrResult[]) {}

  async recognize(): Promise<OcrResult> {
    const result = this.results[this.recognizeCount];
    this.recognizeCount += 1;
    if (!result) throw new Error("Missing mocked OCR result");
    return result;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}
