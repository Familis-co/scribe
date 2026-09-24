import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  addJob: vi.fn(),
  addWorker: vi.fn(),
  createScheduler: vi.fn(),
  createWorker: vi.fn(),
  setParameters: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  access: mocks.access,
}));

vi.mock("tesseract.js", () => ({
  createScheduler: mocks.createScheduler,
  createWorker: mocks.createWorker,
  OEM: { LSTM_ONLY: 1 },
  PSM: { AUTO: "3", SINGLE_BLOCK: "6" },
}));

import { AbortError, DisposedError, OcrError } from "@familis/scribe";
import sharp from "sharp";
import { createTesseractEngine, PSM } from "../src/index.js";

/** A 256 × 1 grayscale ramp whose pixel at index `n` has gray level `n`. */
const gradient = {
  data: Uint8Array.from({ length: 256 }, (_, index) => index),
  width: 256,
  height: 1,
  format: "gray8",
} as const;

/**
 * Decodes the PNG the adapter sent to Tesseract back into one gray level per pixel.
 *
 * @param call - Index of the `addJob` call to inspect
 * @returns The gray level of every pixel, left to right
 */
async function sentPixels(call = 0): Promise<Uint8Array> {
  const png: unknown = mocks.addJob.mock.calls[call]?.[1];
  if (!Buffer.isBuffer(png)) throw new Error(`addJob call ${call} carried no PNG buffer.`);
  return new Uint8Array(await sharp(png).extractChannel(0).raw().toBuffer());
}

describe("Tesseract adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue(undefined);
    mocks.createScheduler.mockReturnValue({
      addJob: mocks.addJob,
      addWorker: mocks.addWorker,
      terminate: mocks.terminate,
    });
    mocks.createWorker.mockResolvedValue({
      setParameters: mocks.setParameters,
      terminate: vi.fn(),
    });
    mocks.setParameters.mockResolvedValue({ jobId: "parameters", data: {} });
    mocks.terminate.mockResolvedValue(undefined);
    mocks.addJob.mockResolvedValue({
      data: {
        confidence: 93,
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  {
                    words: [
                      { text: "Hello", confidence: 96, bbox: { x0: 10, y0: 5, x1: 50, y1: 20 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("reuses a worker pool per normalized language set", async () => {
    const engine = await createTesseractEngine({
      languageDataPath: "/models",
      cachePath: "/cache",
      concurrency: 2,
    });
    const bitmap = {
      data: new Uint8Array(100).fill(255),
      width: 10,
      height: 10,
      format: "gray8",
      dpi: 300,
    } as const;
    const first = await engine.recognize(bitmap, { languages: ["fra", "eng"] });
    await engine.recognize(bitmap, { languages: ["eng", "fra"] });

    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
    expect(mocks.createWorker).toHaveBeenCalledWith(
      ["eng", "fra"],
      1,
      expect.objectContaining({ langPath: "/models", cachePath: "/cache" }),
    );
    expect(first.confidence).toBe(0.93);
    expect(first.tokens[0]).toMatchObject({ text: "Hello", source: "ocr", confidence: 0.96 });
    const encodedImage = mocks.addJob.mock.calls[0]?.[1];
    expect(Buffer.isBuffer(encodedImage)).toBe(true);
    expect((await sharp(encodedImage).metadata()).density).toBe(300);
    await engine.close();
    await engine.close();
    expect(mocks.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects an already aborted recognition", async () => {
    const engine = await createTesseractEngine({ languageDataPath: "/models" });
    const controller = new AbortController();
    controller.abort("stop");
    await expect(
      engine.recognize(
        { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" },
        { languages: ["eng"], signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(AbortError);
    await engine.close();
  });

  it("reads gzipped language data unless compressed is false", async () => {
    const bitmap = { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" } as const;
    const gzipped = await createTesseractEngine({ languageDataPath: "/models" });
    await gzipped.recognize(bitmap, { languages: ["fra"] });
    const plain = await createTesseractEngine({ languageDataPath: "/models", compressed: false });
    await plain.recognize(bitmap, { languages: ["fra"] });

    expect(mocks.createWorker.mock.calls[0]?.[2]).toMatchObject({ gzip: true });
    expect(mocks.createWorker.mock.calls[1]?.[2]).toMatchObject({ gzip: false });
    await gzipped.close();
    await plain.close();
  });

  it("rejects with OcrError when language data fails to load, and remembers the failure", async () => {
    // Tesseract.js reports a missing language file to errorHandler and never settles createWorker.
    mocks.createWorker.mockImplementationOnce(
      (_languages: string[], _oem: number, options: { errorHandler: (report: string) => void }) => {
        queueMicrotask(() =>
          options.errorHandler(
            "Error: ENOENT: no such file or directory, open '/models/fra.traineddata.gz'",
          ),
        );
        return new Promise(() => {});
      },
    );
    const engine = await createTesseractEngine({ languageDataPath: "/models" });
    const bitmap = { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" } as const;

    const failure = engine.recognize(bitmap, { languages: ["fra"] });
    await expect(failure).rejects.toBeInstanceOf(OcrError);
    await expect(failure).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining("ENOENT") }),
    });
    expect(mocks.addJob).not.toHaveBeenCalled();

    // Each failed start leaks a worker thread, so the failure is not retried.
    await expect(engine.recognize(bitmap, { languages: ["fra"] })).rejects.toBe(
      await failure.catch((error: unknown) => error),
    );
    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("rejects a missing language file without starting a worker", async () => {
    const missing = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
    mocks.access.mockImplementation(async (file: string) => {
      if (file.includes("deu")) throw missing;
    });
    const engine = await createTesseractEngine({ languageDataPath: "/models" });
    const bitmap = { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" } as const;

    for (let attempt = 0; attempt < 3; attempt++) {
      const failure = engine.recognize(bitmap, { languages: ["fra", "deu"] });
      await expect(failure).rejects.toBeInstanceOf(OcrError);
      await expect(failure).rejects.toMatchObject({
        message: expect.stringMatching(/deu\.traineddata\.gz.*\/models/u),
        cause: missing,
      });
    }
    expect(mocks.createWorker).not.toHaveBeenCalled();
    expect(mocks.access).toHaveBeenCalledWith("/models/deu.traineddata.gz", expect.any(Number));

    // The check runs again on every call, so data deployed after the failure is picked up.
    mocks.access.mockResolvedValue(undefined);
    await engine.recognize(bitmap, { languages: ["fra", "deu"] });
    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("checks the file name Tesseract.js reads and skips remote language data", async () => {
    const bitmap = { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" } as const;
    const plain = await createTesseractEngine({ languageDataPath: "/models", compressed: false });
    await plain.recognize(bitmap, { languages: ["fra"] });
    expect(mocks.access).toHaveBeenCalledWith("/models/fra.traineddata", expect.any(Number));

    mocks.access.mockClear();
    const remote = await createTesseractEngine({
      languageDataPath: "https://tessdata.example.com/4.0.0",
    });
    await remote.recognize(bitmap, { languages: ["fra"] });
    expect(mocks.access).not.toHaveBeenCalled();
    await plain.close();
    await remote.close();
  });

  it("starts no worker when closed while the language data is being checked", async () => {
    let checked: (() => void) | undefined;
    mocks.access.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          checked = resolve;
        }),
    );
    const engine = await createTesseractEngine({ languageDataPath: "/models" });
    const pending = engine.recognize(
      { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" },
      { languages: ["eng"] },
    );
    await vi.waitFor(() => expect(checked).toBeDefined());
    await engine.close();
    checked?.();

    await expect(pending).rejects.toBeInstanceOf(DisposedError);
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("terminates the workers that started when a sibling fails", async () => {
    const started = { terminate: vi.fn().mockResolvedValue(undefined) };
    mocks.createWorker
      .mockResolvedValueOnce(started)
      .mockRejectedValueOnce(new Error("core failed to load"));
    const engine = await createTesseractEngine({ languageDataPath: "/models", concurrency: 2 });

    await expect(
      engine.recognize(
        { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" },
        { languages: ["eng"] },
      ),
    ).rejects.toBeInstanceOf(OcrError);
    await vi.waitFor(() => expect(started.terminate).toHaveBeenCalledTimes(1));
    expect(mocks.createScheduler).not.toHaveBeenCalled();
    await engine.close();
  });

  it("ignores errors reported after a worker has started", async () => {
    let report: ((error: string) => void) | undefined;
    mocks.createWorker.mockImplementationOnce(
      async (
        _languages: string[],
        _oem: number,
        options: { errorHandler: (error: string) => void },
      ) => {
        report = options.errorHandler;
        return { terminate: vi.fn() };
      },
    );
    mocks.addJob.mockImplementationOnce(async () => {
      report?.("Error: recognition failed");
      throw new Error("recognition failed");
    });
    const engine = await createTesseractEngine({ languageDataPath: "/models" });
    const bitmap = { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" } as const;

    await expect(engine.recognize(bitmap, { languages: ["eng"] })).rejects.toBeInstanceOf(OcrError);
    await engine.recognize(bitmap, { languages: ["eng"] });
    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("sends the page bitmap untouched by default", async () => {
    const engine = await createTesseractEngine({ languageDataPath: "/models" });
    await engine.recognize(gradient, { languages: ["eng"] });

    expect(await sentPixels()).toEqual(gradient.data);
    await engine.close();
  });

  it("binarizes the page bitmap at the configured threshold", async () => {
    const engine = await createTesseractEngine({
      languageDataPath: "/models",
      preprocess: { threshold: 160 },
    });
    await engine.recognize(gradient, { languages: ["eng"] });

    const pixels = await sentPixels();
    expect(pixels).toHaveLength(256);
    expect(pixels.every((level) => level === 0 || level === 255)).toBe(true);
    expect(pixels.indexOf(255)).toBe(160);
    expect(pixels.subarray(160).every((level) => level === 255)).toBe(true);
    await engine.close();
  });

  it("sharpens the page bitmap before thresholding it", async () => {
    // A soft vertical edge: sharpening overshoots on both sides of it.
    const edge = {
      data: Uint8Array.from({ length: 16 * 16 }, (_, index) => (index % 16 < 8 ? 60 : 200)),
      width: 16,
      height: 16,
      format: "gray8",
    } as const;
    const sharpened = await createTesseractEngine({
      languageDataPath: "/models",
      preprocess: { sharpen: true, threshold: null },
    });
    await sharpened.recognize(edge, { languages: ["eng"] });
    const both = await createTesseractEngine({
      languageDataPath: "/models",
      preprocess: { sharpen: true, threshold: 128 },
    });
    await both.recognize(edge, { languages: ["eng"] });

    const levels = new Set(await sentPixels(0));
    expect(levels.size).toBeGreaterThan(2);
    expect([...levels].some((level) => level < 60 || level > 200)).toBe(true);
    expect(new Set(await sentPixels(1))).toEqual(new Set([0, 255]));
    await sharpened.close();
    await both.close();
  });

  it("rejects a threshold outside 0 to 255", async () => {
    for (const threshold of [-1, 256, 160.5, Number.NaN]) {
      await expect(
        createTesseractEngine({ languageDataPath: "/models", preprocess: { threshold } }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("sets the page segmentation mode only when configured", async () => {
    const bitmap = { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" } as const;
    const automatic = await createTesseractEngine({ languageDataPath: "/models" });
    await automatic.recognize(bitmap, { languages: ["eng"] });
    expect(mocks.setParameters).not.toHaveBeenCalled();

    const block = await createTesseractEngine({
      languageDataPath: "/models",
      pageSegMode: PSM.SINGLE_BLOCK,
      concurrency: 2,
    });
    await block.recognize(bitmap, { languages: ["eng"] });
    expect(mocks.setParameters).toHaveBeenCalledTimes(2);
    expect(mocks.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: "6" });
    await automatic.close();
    await block.close();
  });

  it("requires an explicit language data path", async () => {
    await expect(createTesseractEngine({ languageDataPath: "" })).rejects.toBeInstanceOf(TypeError);
  });

  it("disables the Tesseract.js cache unless cachePath is set", async () => {
    const bitmap = { data: new Uint8Array([255]), width: 1, height: 1, format: "gray8" } as const;
    const uncached = await createTesseractEngine({ languageDataPath: "/models" });
    await uncached.recognize(bitmap, { languages: ["fra"] });
    const cached = await createTesseractEngine({
      languageDataPath: "/models",
      cachePath: "/cache",
    });
    await cached.recognize(bitmap, { languages: ["fra"] });

    // Without a cachePath, Tesseract.js would write its cache into the working directory.
    const [uncachedOptions, cachedOptions] = mocks.createWorker.mock.calls.map((call) => call[2]);
    expect(uncachedOptions).toMatchObject({ cacheMethod: "none" });
    expect(uncachedOptions).not.toHaveProperty("cachePath");
    expect(cachedOptions).toMatchObject({ cachePath: "/cache" });
    expect(cachedOptions).not.toHaveProperty("cacheMethod");
    await uncached.close();
    await cached.close();
  });
});
