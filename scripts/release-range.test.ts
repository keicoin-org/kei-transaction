import { describe, expect, test } from "bun:test";
import { caretIncludes } from "./release-range.mjs";

describe("release dependency caret compatibility", () => {
  test("a patch release stays inside its existing pre-1.0 minor range", () => {
    expect(caretIncludes("^0.5.0", "0.5.1")).toBe(true);
    expect(caretIncludes("^0.5.2", "0.5.1")).toBe(false);
  });

  test("adjacent pre-1.0 minor ranges stay incompatible", () => {
    expect(caretIncludes("^0.4.9", "0.5.1")).toBe(false);
    expect(caretIncludes("^0.6.0", "0.5.1")).toBe(false);
  });

  test("a 0.0 caret admits only its exact patch", () => {
    expect(caretIncludes("^0.0.3", "0.0.3")).toBe(true);
    expect(caretIncludes("^0.0.3", "0.0.4")).toBe(false);
  });

  test("a stable major caret admits later 1.x releases above its floor", () => {
    expect(caretIncludes("^1.2.3", "1.2.3")).toBe(true);
    expect(caretIncludes("^1.2.3", "1.9.9")).toBe(true);
    expect(caretIncludes("^1.2.3", "1.2.2")).toBe(false);
    expect(caretIncludes("^1.2.3", "2.0.0")).toBe(false);
  });

  test("non-caret, compound, partial, and prerelease shapes are rejected", () => {
    expect(caretIncludes("0.5.0", "0.5.1")).toBe(false);
    expect(caretIncludes("~0.5.0", "0.5.1")).toBe(false);
    expect(() => caretIncludes("^0.5", "0.5.1")).toThrow();
    expect(() => caretIncludes("^0.5.0 || ^0.6.0", "0.5.1")).toThrow();
    expect(() => caretIncludes("^0.5.0-beta.1", "0.5.1")).toThrow();
    expect(() => caretIncludes("^0.5.0", "0.5.1-beta.1")).toThrow();
  });
});
