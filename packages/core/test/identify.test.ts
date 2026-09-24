import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AmbiguousProfileError,
  createScribe,
  defineProfile,
  field,
  ProfileMismatchError,
  select,
  type ProfileIdentify,
  type TextToken,
} from "../src/index.js";
import { box, MockOcrEngine, MockPdfEngine, token } from "./helpers.js";

/**
 * Builds a profile reading the value after `Ref:`.
 *
 * @param id - Profile identifier
 * @param identify - Optional identification rules
 * @returns The profile
 */
const profileWith = (id: string, identify?: ProfileIdentify) =>
  defineProfile({
    id,
    version: "1",
    languages: ["fra"],
    schema: z.object({ reference: z.string() }),
    fields: { reference: field.text({ select: select.afterAnchor({ text: "Ref:" }) }) },
    ...(identify ? { identify } : {}),
  });

/** A visit schedule: its title, then a reference line. */
const schedule: TextToken[] = [
  token("Planning", box(0.1, 0.1), 0),
  token("des", box(0.21, 0.1), 0),
  token("visites", box(0.32, 0.1), 0),
  token("Ref:", box(0.1, 0.2), 1),
  token("A-42", box(0.21, 0.2), 1),
];

/** An invoice with a reference but little other native text. */
const invoice: TextToken[] = [token("Facture", box(0.1, 0.1), 0), token("Ref:", box(0.1, 0.2), 1)];

const scheduleProfile = profileWith("visit-schedule", { text: [/planning/iu, "DES VISITES"] });
const invoiceProfile = profileWith("invoice", { text: ["facture"] });

describe("profile.identify", () => {
  it("rejects a document of another type before any render or OCR", async () => {
    for (const mode of ["auto", "always"] as const) {
      const pdf = new MockPdfEngine([invoice]);
      const ocr = new MockOcrEngine([]);
      const failure = createScribe({ pdf, ocr }).parse(new Uint8Array([1]), scheduleProfile, {
        ocr: mode,
      });

      await expect(failure).rejects.toBeInstanceOf(ProfileMismatchError);
      await expect(failure).rejects.toMatchObject({
        code: "PROFILE_MISMATCH",
        profileIds: ["visit-schedule"],
        message:
          'The document does not match profile "visit-schedule": /planning/iu was not found; "DES VISITES" was not found.',
      });
      expect(pdf.document.pages[0]?.renderCount).toBe(0);
      expect(ocr.recognizeCount).toBe(0);
      expect(pdf.document.closeCount).toBe(1);
    }
  });

  it("parses a matching document, comparing literals without case by default", async () => {
    const result = await createScribe({ pdf: new MockPdfEngine([schedule]) }).parse(
      new Uint8Array([1]),
      scheduleProfile,
    );
    expect(result.data).toEqual({ reference: "A-42" });

    const strict = profileWith("strict", { text: ["DES VISITES"], caseSensitive: true });
    await expect(
      createScribe({ pdf: new MockPdfEngine([schedule]) }).parse(new Uint8Array([1]), strict),
    ).rejects.toBeInstanceOf(ProfileMismatchError);
  });

  it("runs the test predicate on the native text once the text rules pass", async () => {
    const test = vi.fn(({ pageCount }: { pageCount: number }) => pageCount <= 1);
    const profile = profileWith("short", { text: ["planning"], test });
    const scribe = createScribe({ pdf: new MockPdfEngine([schedule, []]) });

    await expect(scribe.parse(new Uint8Array([1]), profile)).rejects.toMatchObject({
      message: 'The document does not match profile "short": the test predicate failed.',
    });
    expect(test).toHaveBeenCalledWith({
      text: "Planning des visites\nRef: A-42\n",
      pages: ["Planning des visites\nRef: A-42", ""],
      pageCount: 2,
    });

    test.mockClear();
    await expect(
      createScribe({ pdf: new MockPdfEngine([invoice]) }).parse(new Uint8Array([1]), profile),
    ).rejects.toBeInstanceOf(ProfileMismatchError);
    expect(test).not.toHaveBeenCalled();
  });

  it("validates the rules", () => {
    expect(() => profileWith("empty", {})).toThrow(TypeError);
    expect(() => profileWith("blank", { text: [""] })).toThrow(TypeError);
  });
});

describe("scribe.identify", () => {
  it("returns the only matching profile without rendering", async () => {
    const pdf = new MockPdfEngine([invoice]);
    const scribe = createScribe({ pdf });
    const profile = await scribe.identify(new Uint8Array([1]), [scheduleProfile, invoiceProfile]);

    expect(profile).toBe(invoiceProfile);
    expect(pdf.document.pages[0]?.renderCount).toBe(0);
    expect(pdf.document.closeCount).toBe(1);
  });

  it("throws ProfileMismatchError when no profile matches", async () => {
    const scribe = createScribe({ pdf: new MockPdfEngine([[token("Contrat", box(0, 0))]]) });
    await expect(
      scribe.identify(new Uint8Array([1]), [scheduleProfile, invoiceProfile]),
    ).rejects.toMatchObject({
      code: "PROFILE_MISMATCH",
      profileIds: ["visit-schedule", "invoice"],
    });
  });

  it("throws AmbiguousProfileError listing every matching profile", async () => {
    const scribe = createScribe({ pdf: new MockPdfEngine([[...schedule, ...invoice]]) });
    const failure = scribe.identify(new Uint8Array([1]), [scheduleProfile, invoiceProfile]);
    await expect(failure).rejects.toBeInstanceOf(AmbiguousProfileError);
    await expect(failure).rejects.toMatchObject({
      code: "AMBIGUOUS_PROFILE",
      profileIds: ["visit-schedule", "invoice"],
    });
  });

  it("requires identify rules on every candidate", async () => {
    const pdf = new MockPdfEngine([schedule]);
    const scribe = createScribe({ pdf });
    await expect(scribe.identify(new Uint8Array([1]), [])).rejects.toBeInstanceOf(TypeError);
    await expect(
      scribe.identify(new Uint8Array([1]), [scheduleProfile, profileWith("plain")]),
    ).rejects.toThrow("Profiles without identify rules cannot be identified: plain.");
    expect(pdf.document.closeCount).toBe(0);
  });
});
