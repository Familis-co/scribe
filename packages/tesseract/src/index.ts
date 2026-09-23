/**
 * Tesseract.js OCR adapter with Sharp image preparation and reusable worker pools.
 *
 * @packageDocumentation
 */
import {
  AbortError,
  DisposedError,
  OcrError,
  type OcrEngine,
  type OcrRecognizeOptions,
  type OcrResult,
  type PageBitmap,
  type TextToken,
} from "@familis/scribe";
import sharp from "sharp";
import { createScheduler, createWorker, OEM, type LoggerMessage } from "tesseract.js";

type Scheduler = ReturnType<typeof createScheduler>;

/** Configuration for a local Tesseract.js OCR engine. */
export interface TesseractEngineOptions {
  /**
   * Explicit Tesseract.js-compatible language-data path.
   *
   * @remarks
   * A local absolute path is recommended in production. No path is selected automatically.
   */
  readonly languageDataPath: string;
  /** Writable Tesseract.js cache directory. */
  readonly cachePath?: string;
  /** Custom Tesseract.js worker script location. */
  readonly workerPath?: string;
  /** Custom Tesseract core/WASM location. */
  readonly corePath?: string;
  /** Number of reusable workers created per normalized language set. @defaultValue `1` */
  readonly concurrency?: number;
  /** Receives Tesseract.js progress and status messages. */
  readonly logger?: (message: LoggerMessage) => void;
}

interface WorkerPool {
  readonly scheduler: Scheduler;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new AbortError("The OCR operation was aborted.", { cause: signal.reason });
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  abortIfNeeded(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void =>
      reject(new AbortError("The OCR operation was aborted.", { cause: signal.reason }));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
        return undefined;
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
        return undefined;
      },
    );
  });
}

function normalizedTokens(
  blocks: Tesseract.Block[] | null,
  width: number,
  height: number,
): readonly TextToken[] {
  if (!blocks) return [];
  const tokens: TextToken[] = [];
  let lineIndex = 0;
  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const { x0, y0, x1, y1 } = word.bbox;
          tokens.push({
            text: word.text,
            box: {
              x: Math.min(1, Math.max(0, x0 / width)),
              y: Math.min(1, Math.max(0, y0 / height)),
              width: Math.min(1, Math.max(0, (x1 - x0) / width)),
              height: Math.min(1, Math.max(0, (y1 - y0) / height)),
            },
            source: "ocr",
            confidence: Math.min(1, Math.max(0, word.confidence / 100)),
            lineIndex,
          });
        }
        lineIndex += 1;
      }
    }
  }
  return tokens;
}

async function imageBuffer(bitmap: PageBitmap): Promise<Buffer> {
  const channels = bitmap.format === "gray8" ? 1 : 4;
  return sharp(bitmap.data, {
    raw: { width: bitmap.width, height: bitmap.height, channels },
  })
    .png()
    .withMetadata({ density: bitmap.dpi ?? 300 })
    .toBuffer();
}

class TesseractEngine implements OcrEngine {
  readonly #pools = new Map<string, Promise<WorkerPool>>();
  #closed = false;

  constructor(
    private readonly options: Required<Pick<TesseractEngineOptions, "concurrency">> &
      TesseractEngineOptions,
  ) {}

  async recognize(bitmap: PageBitmap, options: OcrRecognizeOptions): Promise<OcrResult> {
    if (this.#closed) throw new DisposedError();
    abortIfNeeded(options.signal);
    if (options.languages.length === 0)
      throw new OcrError("At least one OCR language is required.");
    const pool = await this.#pool(options.languages);
    const image = await imageBuffer(bitmap);
    abortIfNeeded(options.signal);
    try {
      const result = await withAbort(
        pool.scheduler.addJob(
          "recognize",
          image,
          { rotateAuto: false },
          { text: true, blocks: true },
        ),
        options.signal,
      );
      return {
        tokens: normalizedTokens(result.data.blocks, bitmap.width, bitmap.height),
        confidence: Math.min(1, Math.max(0, result.data.confidence / 100)),
      };
    } catch (cause) {
      if (cause instanceof AbortError) throw cause;
      throw new OcrError("Tesseract could not recognize the page image.", { cause });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pools = await Promise.allSettled(this.#pools.values());
    await Promise.all(
      pools.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.scheduler.terminate()] : [],
      ),
    );
    this.#pools.clear();
  }

  #pool(languages: readonly string[]): Promise<WorkerPool> {
    const normalized = [
      ...new Set(languages.map((language) => language.trim()).filter(Boolean)),
    ].toSorted();
    const key = normalized.join("+");
    const existing = this.#pools.get(key);
    if (existing) return existing;
    const created = this.#createPool(normalized);
    this.#pools.set(key, created);
    return created;
  }

  async #createPool(languages: readonly string[]): Promise<WorkerPool> {
    const scheduler = createScheduler();
    try {
      const workers = await Promise.all(
        Array.from({ length: this.options.concurrency }, () =>
          createWorker([...languages], OEM.LSTM_ONLY, {
            langPath: this.options.languageDataPath,
            ...(this.options.cachePath ? { cachePath: this.options.cachePath } : {}),
            ...(this.options.workerPath ? { workerPath: this.options.workerPath } : {}),
            ...(this.options.corePath ? { corePath: this.options.corePath } : {}),
            ...(this.options.logger ? { logger: this.options.logger } : {}),
          }),
        ),
      );
      for (const worker of workers) scheduler.addWorker(worker);
      return { scheduler };
    } catch (cause) {
      await scheduler.terminate();
      throw new OcrError(`Could not initialize Tesseract for ${languages.join(", ")}.`, { cause });
    }
  }
}

/**
 * Creates a reusable local OCR engine backed by Tesseract.js workers.
 *
 * @param options - Language data, cache, worker, and concurrency configuration
 * @returns An OCR engine that initializes worker pools lazily per language set
 *
 * @throws `TypeError` when `languageDataPath` is empty
 * @throws `RangeError` when concurrency is not a positive integer
 *
 * @remarks
 * The returned engine accepts rendered bitmaps, not PDF files. Call {@link OcrEngine.close} during
 * application shutdown to terminate all initialized workers.
 *
 * @example
 * ```ts
 * const ocr = await createTesseractEngine({
 *   languageDataPath: "/opt/tessdata",
 *   cachePath: "/var/cache/scribe",
 *   concurrency: 1,
 * });
 * ```
 *
 * @public
 */
export async function createTesseractEngine(options: TesseractEngineOptions): Promise<OcrEngine> {
  if (options.languageDataPath.trim() === "") {
    throw new TypeError(
      "languageDataPath must point to explicitly configured Tesseract language data.",
    );
  }
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Tesseract concurrency must be a positive integer.");
  }
  return new TesseractEngine({ ...options, concurrency });
}
