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

import { AbortError } from "@familis/scribe";
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

  it("requires an explicit language data path", async () => {
    await expect(createTesseractEngine({ languageDataPath: "" })).rejects.toBeInstanceOf(TypeError);
  });
});
