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
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { createScheduler, createWorker, OEM, type LoggerMessage, type PSM } from "tesseract.js";

export { PSM } from "tesseract.js";

/** Tesseract.js scheduler that dispatches jobs across a pool of workers. */
type Scheduler = ReturnType<typeof createScheduler>;

/** Initialized Tesseract.js worker. */
type Worker = Awaited<ReturnType<typeof createWorker>>;

/** Image adjustments applied to each page bitmap before it is sent to Tesseract. */
export interface TesseractPreprocessOptions {
  /**
   * Binarizes the image at this gray level: pixels at or above it become white, the rest black.
   *
   * @remarks
   * An integer from `0` to `255`. `null` or omitted leaves the gray levels untouched.
   *
   * @defaultValue `null`
   */
  readonly threshold?: number | null;
  /**
   * Applies a mild sharpen before any thresholding.
   *
   * @defaultValue `false`
   */
  readonly sharpen?: boolean;
}

/** Resampling of low-resolution page bitmaps before they are sent to Tesseract. */
export interface TesseractUpscaleOptions {
  /**
   * Density that bitmaps rendered below it are enlarged to, in dots per inch.
   *
   * @remarks
   * A finite number above `0`. Tesseract reads best at about 300 DPI of glyph detail.
   *
   * @defaultValue `300`
   */
  readonly targetDpi?: number;
  /**
   * Largest enlargement factor applied to a bitmap.
   *
   * @remarks
   * A finite number of at least `1`. A bitmap too small to reach `targetDpi` within it is enlarged
   * by this factor and sent at the density it reaches.
   *
   * @defaultValue `4`
   */
  readonly maxFactor?: number;
}

/** Configuration for a local Tesseract.js OCR engine. */
export interface TesseractEngineOptions {
  /**
   * Explicit Tesseract.js-compatible language-data path.
   *
   * @remarks
   * A local absolute path is recommended in production. No path is selected automatically.
   */
  readonly languageDataPath: string;
  /**
   * Whether the language data is gzipped.
   *
   * @remarks
   * When `true`, Tesseract.js reads `<lang>.traineddata.gz`. Set it to `false` for a directory of
   * plain `<lang>.traineddata` files, the layout tessdata is distributed in.
   *
   * @defaultValue `true`
   */
  readonly compressed?: boolean;
  /**
   * Writable directory where Tesseract.js caches the language data it loads.
   *
   * @remarks
   * Omitted, no cache is read or written. Tesseract.js would otherwise write its copy of the
   * language data into the process's working directory. A local `languageDataPath` gains nothing
   * from a cache, which only copies one local file to another.
   */
  readonly cachePath?: string;
  /** Custom Tesseract.js worker script location. */
  readonly workerPath?: string;
  /** Custom Tesseract core/WASM location. */
  readonly corePath?: string;
  /** Number of reusable workers created per normalized language set. @defaultValue `1` */
  readonly concurrency?: number;
  /** Receives Tesseract.js progress and status messages. */
  readonly logger?: (message: LoggerMessage) => void;
  /**
   * Enlarges bitmaps whose `dpi` is below the target density with a Lanczos kernel, before
   * `preprocess` runs.
   *
   * @remarks
   * A bitmap without `dpi` is never resized. `false` disables upscaling.
   *
   * @defaultValue `{ targetDpi: 300, maxFactor: 4 }`
   */
  readonly upscale?: TesseractUpscaleOptions | false;
  /** Image adjustments applied before recognition. All are off by default. */
  readonly preprocess?: TesseractPreprocessOptions;
  /**
   * Tesseract page segmentation mode, set on every worker.
   *
   * @remarks
   * Omitted, the parameter is not set and Tesseract keeps its own default, `PSM.AUTO`.
   */
  readonly pageSegMode?: PSM;
  /**
   * Drops recognized words whose confidence is below this value.
   *
   * @remarks
   * A number from `0` to `1`, compared with each word's confidence after it is scaled from
   * Tesseract's `0`–`100`. The page-level confidence is Tesseract's own and ignores this filter.
   *
   * @defaultValue `0`, which keeps every word
   */
  readonly minWordConfidence?: number;
  /**
   * Drops recognized words that contain no Unicode letter or digit, such as `|`, `'` or `—`.
   *
   * @remarks
   * Words mixing symbols with letters or digits, such as `N°` or `1/2`, are kept.
   *
   * @defaultValue `false`
   */
  readonly dropPunctuationOnly?: boolean;
}

/** Word filters applied while Tesseract output is converted into tokens. */
interface WordFilter {
  readonly minWordConfidence: number;
  readonly dropPunctuationOnly: boolean;
}

/** PNG input for Tesseract with the pixel size and density it was encoded at. */
interface PreparedImage {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly dpi: number;
}

/** Initialized workers dedicated to one normalized language set. */
interface WorkerPool {
  readonly scheduler: Scheduler;
}

/**
 * Throws when a cancellation signal has already fired.
 *
 * @param signal - Optional cancellation signal
 * @throws `AbortError` when the signal is aborted, with its reason as `cause`
 */
function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new AbortError("The OCR operation was aborted.", { cause: signal.reason });
}

/**
 * Rejects as soon as a signal fires, without cancelling the underlying work.
 *
 * @remarks
 * Tesseract.js jobs cannot be interrupted, so an aborted recognition keeps its worker busy until it
 * completes. The caller only stops waiting.
 *
 * @typeParam T - Resolved value type
 * @param promise - Operation to wait for
 * @param signal - Optional cancellation signal
 * @returns The operation's value when it settles before the signal fires
 * @throws `AbortError` when the signal fires first
 */
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

/**
 * Rejects before any worker starts when a language file is missing from a local directory.
 *
 * @remarks
 * A worker whose language data fails to load cannot be terminated, so catching the common failure
 * here keeps it from leaking a thread. Remote locations are left to Tesseract.js, which treats any
 * `scheme://` or protocol-relative `//` path as a URL.
 *
 * @param languageDataPath - Configured language-data location
 * @param languages - Normalized language identifiers
 * @param compressed - Whether Tesseract.js reads `.traineddata.gz` rather than `.traineddata`
 * @throws `OcrError` naming each missing file and the configured path, with the first file-system
 * error as `cause`
 */
async function assertLanguageData(
  languageDataPath: string,
  languages: readonly string[],
  compressed: boolean,
): Promise<void> {
  if (/^(?:[a-z][\w+.-]*:)?\/\//iu.test(languageDataPath)) return;
  const extension = compressed ? ".traineddata.gz" : ".traineddata";
  const checks = await Promise.allSettled(
    languages.map((language) =>
      access(join(languageDataPath, `${language}${extension}`), constants.R_OK),
    ),
  );
  const missing = languages.flatMap((language, index) =>
    checks[index]?.status === "rejected" ? [`${language}${extension}`] : [],
  );
  if (missing.length === 0) return;
  const cause = checks.find((check) => check.status === "rejected")?.reason;
  throw new OcrError(
    `Tesseract language data ${missing.join(", ")} is missing or unreadable in languageDataPath ` +
      `${languageDataPath}.`,
    { cause },
  );
}

/**
 * Converts Tesseract word boxes into normalized OCR tokens, discarding filtered words.
 *
 * @remarks
 * Line indices still advance for a line whose words were all dropped, so they stay one per
 * Tesseract line.
 *
 * @param blocks - Tesseract layout blocks, or `null` when no layout was produced
 * @param width - Width in pixels of the image Tesseract read
 * @param height - Height in pixels of the image Tesseract read
 * @param filter - Word filters to apply
 * @returns Word tokens in reading order with one line index per Tesseract line, and the number of
 * words dropped
 */
function normalizedTokens(
  blocks: Tesseract.Block[] | null,
  width: number,
  height: number,
  filter: WordFilter,
): { readonly tokens: readonly TextToken[]; readonly dropped: number } {
  if (!blocks) return { tokens: [], dropped: 0 };
  const tokens: TextToken[] = [];
  let dropped = 0;
  let lineIndex = 0;
  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const confidence = Math.min(1, Math.max(0, word.confidence / 100));
          if (
            confidence < filter.minWordConfidence ||
            (filter.dropPunctuationOnly && !/[\p{L}\p{N}]/u.test(word.text))
          ) {
            dropped += 1;
            continue;
          }
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
            confidence,
            lineIndex,
          });
        }
        lineIndex += 1;
      }
    }
  }
  return { tokens, dropped };
}

/**
 * Encodes a raw bitmap as a PNG that Tesseract.js can read.
 *
 * @remarks
 * Sharp runs its operations in a fixed order, so sharpening always happens before thresholding,
 * whichever way they are chained. Resizing comes before both, so the adjustments act on the
 * upscaled pixels.
 *
 * @param bitmap - Grayscale or RGBA page render
 * @param preprocess - Adjustments applied before PNG encoding
 * @param upscale - Upscaling applied before `preprocess`, or `false` to keep the bitmap size
 * @returns PNG bytes with their pixel size and density: the bitmap density times the upscale
 * factor, or 300 DPI when the bitmap density is unknown
 */
async function imageBuffer(
  bitmap: PageBitmap,
  preprocess: TesseractPreprocessOptions = {},
  upscale: TesseractUpscaleOptions | false = {},
): Promise<PreparedImage> {
  const channels = bitmap.format === "gray8" ? 1 : 4;
  const image = sharp(bitmap.data, {
    raw: { width: bitmap.width, height: bitmap.height, channels },
  });
  let factor = 1;
  if (upscale !== false && bitmap.dpi !== undefined) {
    const targetDpi = upscale.targetDpi ?? 300;
    if (bitmap.dpi < targetDpi) factor = Math.min(upscale.maxFactor ?? 4, targetDpi / bitmap.dpi);
  }
  const width = Math.round(bitmap.width * factor);
  const height = Math.round(bitmap.height * factor);
  // `fill` keeps rounding from cropping a row or column to preserve the aspect ratio.
  if (factor > 1) image.resize(width, height, { kernel: "lanczos3", fit: "fill" });
  if (preprocess.sharpen) image.sharpen();
  if (preprocess.threshold != null) image.threshold(preprocess.threshold);
  const dpi = bitmap.dpi === undefined ? 300 : bitmap.dpi * factor;
  const png = await image.png().withMetadata({ density: dpi }).toBuffer();
  return { png, width, height, dpi };
}

/** OCR engine that lazily creates one worker pool per language set. */
class TesseractEngine implements OcrEngine {
  readonly #pools = new Map<string, Promise<WorkerPool>>();
  #closed = false;

  /**
   * Stores validated engine options.
   *
   * @param options - Engine options with a resolved worker concurrency
   */
  constructor(
    private readonly options: Required<Pick<TesseractEngineOptions, "concurrency">> &
      TesseractEngineOptions,
  ) {}

  /**
   * {@inheritDoc @familis/scribe#OcrEngine.recognize}
   *
   * @throws `OcrError` when no language is given, a language file is missing, initialization
   * fails, or recognition fails
   * @throws `AbortError` when the signal fires before recognition completes
   * @throws `DisposedError` when the engine is closed while the language data is being checked
   */
  async recognize(bitmap: PageBitmap, options: OcrRecognizeOptions): Promise<OcrResult> {
    if (this.#closed) throw new DisposedError();
    abortIfNeeded(options.signal);
    if (options.languages.length === 0)
      throw new OcrError("At least one OCR language is required.");
    const pool = await this.#pool(options.languages);
    const image = await imageBuffer(bitmap, this.options.preprocess, this.options.upscale);
    abortIfNeeded(options.signal);
    // Tesseract.js sets every key it does not own as a Tesseract variable for this job only, and
    // restores the previous values once the job completes.
    const parameters: Partial<Tesseract.RecognizeOptions & Tesseract.WorkerParams> = {
      rotateAuto: false,
      user_defined_dpi: String(Math.round(image.dpi)),
      preserve_interword_spaces: "1",
    };
    try {
      const result = await withAbort(
        pool.scheduler.addJob("recognize", image.png, parameters, { text: true, blocks: true }),
        options.signal,
      );
      // Tesseract's boxes are in the pixels it read, so dividing by the upscaled size normalizes
      // them to the original bitmap.
      const { tokens, dropped } = normalizedTokens(result.data.blocks, image.width, image.height, {
        minWordConfidence: this.options.minWordConfidence ?? 0,
        dropPunctuationOnly: this.options.dropPunctuationOnly ?? false,
      });
      return {
        tokens,
        confidence: Math.min(1, Math.max(0, result.data.confidence / 100)),
        droppedTokenCount: dropped,
      };
    } catch (cause) {
      if (cause instanceof AbortError) throw cause;
      throw new OcrError("Tesseract could not recognize the page image.", { cause });
    }
  }

  /** {@inheritDoc @familis/scribe#OcrEngine.close} */
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

  /**
   * Returns the worker pool for a language set, creating it on first use.
   *
   * @remarks
   * A missing language file rejects before any worker starts and is checked again on the next call,
   * so data added later is picked up. A pool whose workers failed to start stays cached as a
   * rejection: every failed start leaks a thread, so it happens at most once per language set.
   *
   * @param languages - Requested languages, deduplicated and sorted to form the cache key
   * @returns The shared pool for this language set
   * @throws `OcrError` when a language file is missing or a worker cannot be initialized
   * @throws `DisposedError` when the engine is closed while the language data is being checked
   */
  async #pool(languages: readonly string[]): Promise<WorkerPool> {
    const normalized = [
      ...new Set(languages.map((language) => language.trim()).filter(Boolean)),
    ].toSorted();
    const key = normalized.join("+");
    const existing = this.#pools.get(key);
    if (existing) return existing;
    await assertLanguageData(
      this.options.languageDataPath,
      normalized,
      this.options.compressed ?? true,
    );
    // The check yields, so a concurrent call may have created the pool, or close() may have run.
    const created = this.#pools.get(key);
    if (created) return created;
    if (this.#closed) throw new DisposedError();
    const pool = this.#createPool(normalized);
    this.#pools.set(key, pool);
    return pool;
  }

  /**
   * Starts the configured number of workers for a language set.
   *
   * @param languages - Normalized language identifiers
   * @returns A pool whose scheduler owns every started worker
   * @throws `OcrError` when a worker cannot be initialized
   */
  async #createPool(languages: readonly string[]): Promise<WorkerPool> {
    const starting = Array.from({ length: this.options.concurrency }, async () =>
      this.#configure(await this.#startWorker(languages)),
    );
    let workers: Worker[];
    try {
      workers = await Promise.all(starting);
    } catch (cause) {
      // Workers that did start must not outlive the pool. They are terminated without waiting, so
      // the caller is not held up by siblings still loading their language data.
      for (const worker of starting) {
        void worker.then(
          (started) => started.terminate(),
          () => undefined,
        );
      }
      throw new OcrError(`Could not initialize Tesseract for ${languages.join(", ")}.`, { cause });
    }
    const scheduler = createScheduler();
    for (const worker of workers) scheduler.addWorker(worker);
    return { scheduler };
  }

  /**
   * Applies the configured recognition parameters to a started worker.
   *
   * @param worker - Initialized worker
   * @returns The same worker, ready for jobs
   * @throws `Error` when Tesseract.js rejects the parameters, after terminating the worker
   */
  async #configure(worker: Worker): Promise<Worker> {
    if (this.options.pageSegMode === undefined) return worker;
    try {
      await worker.setParameters({ tessedit_pageseg_mode: this.options.pageSegMode });
      return worker;
    } catch (cause) {
      await worker.terminate();
      throw cause;
    }
  }

  /**
   * Starts one Tesseract.js worker and settles once it is ready or has failed.
   *
   * @remarks
   * Tesseract.js 7 only rejects `createWorker` when its core fails to load. A language-data or
   * initialization failure is reported to `errorHandler` while the returned promise stays pending,
   * and without a handler it is thrown from the worker's message listener, where it crashes the
   * process. The handler turns that report into a rejection. After start-up, the handler also
   * receives recognition failures, which already reject their job, so it ignores them.
   *
   * Tesseract.js exposes no handle to a worker whose start-up failed, so its thread cannot be
   * terminated. It stays idle for the life of the process and keeps Node.js from exiting on its own.
   * `#pool` keeps that leak to one start per language set: it checks local language files before
   * any worker starts and remembers a pool that failed. Corrupt language data is still out of reach:
   * Tesseract.js answers the failed `initialize` job twice, and the second answer throws inside its
   * own message listener.
   *
   * @param languages - Normalized language identifiers
   * @returns The initialized worker
   * @throws `Error` carrying the Tesseract.js report when the worker cannot be initialized
   */
  #startWorker(languages: readonly string[]): Promise<Worker> {
    return new Promise<Worker>((resolve, reject) => {
      let settled = false;
      const fail = (cause: unknown): void => {
        if (settled) return;
        settled = true;
        // Tesseract.js reports worker failures as `error.toString()`, so the prefix is dropped.
        reject(cause instanceof Error ? cause : new Error(String(cause).replace(/^Error: /u, "")));
      };
      void createWorker([...languages], OEM.LSTM_ONLY, {
        langPath: this.options.languageDataPath,
        gzip: this.options.compressed ?? true,
        errorHandler: fail,
        ...(this.options.cachePath
          ? { cachePath: this.options.cachePath }
          : { cacheMethod: "none" }),
        ...(this.options.workerPath ? { workerPath: this.options.workerPath } : {}),
        ...(this.options.corePath ? { corePath: this.options.corePath } : {}),
        ...(this.options.logger ? { logger: this.options.logger } : {}),
      }).then((worker) => {
        if (settled) return worker.terminate();
        settled = true;
        resolve(worker);
        return undefined;
      }, fail);
    });
  }
}

/**
 * Creates a reusable local OCR engine backed by Tesseract.js workers.
 *
 * @param options - Language data, cache, worker, and concurrency configuration
 * @returns An OCR engine that initializes worker pools lazily per language set
 *
 * @throws `TypeError` when `languageDataPath` is empty
 * @throws `RangeError` when concurrency is not a positive integer, `preprocess.threshold` is not an
 * integer from 0 to 255, `minWordConfidence` is not a number from 0 to 1, `upscale.targetDpi` is
 * not a finite number above 0, or `upscale.maxFactor` is not a finite number of at least 1
 *
 * @remarks
 * The returned engine accepts rendered bitmaps, not PDF files. Call {@link OcrEngine.close} during
 * application shutdown to terminate all initialized workers.
 *
 * @example
 * ```ts
 * const ocr = await createTesseractEngine({
 *   languageDataPath: "/opt/tessdata",
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
  const threshold = options.preprocess?.threshold;
  if (threshold != null && (!Number.isInteger(threshold) || threshold < 0 || threshold > 255)) {
    throw new RangeError("preprocess.threshold must be an integer from 0 to 255.");
  }
  const minWordConfidence = options.minWordConfidence;
  if (
    minWordConfidence !== undefined &&
    (!Number.isFinite(minWordConfidence) || minWordConfidence < 0 || minWordConfidence > 1)
  ) {
    throw new RangeError("minWordConfidence must be a number from 0 to 1.");
  }
  const targetDpi = options.upscale ? options.upscale.targetDpi : undefined;
  if (targetDpi !== undefined && (!Number.isFinite(targetDpi) || targetDpi <= 0)) {
    throw new RangeError("upscale.targetDpi must be a finite number above 0.");
  }
  const maxFactor = options.upscale ? options.upscale.maxFactor : undefined;
  if (maxFactor !== undefined && (!Number.isFinite(maxFactor) || maxFactor < 1)) {
    throw new RangeError("upscale.maxFactor must be a finite number of at least 1.");
  }
  return new TesseractEngine({ ...options, concurrency });
}
