import { describe, expect, test } from "bun:test";
import { defineProfile, field, select } from "../dist/index.js";

describe("Bun package smoke test", () => {
  test("loads the ESM build", () => {
    expect(typeof defineProfile).toBe("function");
    expect(typeof field.text).toBe("function");
    expect(typeof select.region).toBe("function");
  });
});
