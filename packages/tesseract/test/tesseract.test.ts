import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addJob: vi.fn(),
  addWorker: vi.fn(),
  createScheduler: vi.fn(),
  createWorker: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock("tesseract.js", () => ({
  createScheduler: mocks.createScheduler,
  createWorker: mocks.createWorker,
  OEM: { LSTM_ONLY: 1 },
}));

import { AbortError, OcrError } from "@familis/scribe";
import sharp from "sharp";
import { createTesseractEngine } from "../src/index.js";

describe("Tesseract adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createScheduler.mockReturnValue({
      addJob: mocks.addJob,
      addWorker: mocks.addWorker,
      terminate: mocks.terminate,
    });
    mocks.createWorker.mockResolvedValue({ terminate: vi.fn() });
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

  it("rejects with OcrError when language data fails to load, then retries", async () => {
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

    const retried = await engine.recognize(bitmap, { languages: ["fra"] });
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
    expect(retried.tokens[0]?.text).toBe("Hello");
    await engine.close();
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

  it("requires an explicit language data path", async () => {
    await expect(createTesseractEngine({ languageDataPath: "" })).rejects.toBeInstanceOf(TypeError);
  });
});
