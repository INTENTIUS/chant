import { describe, test, expect } from "bun:test";
import { getCachePath, KCC_VERSION } from "./fetch";

describe("fetch", () => {
  test("cache path includes version", () => {
    const path = getCachePath();
    expect(path).toContain(KCC_VERSION);
    expect(path).toContain(".chant");
    expect(path).toEndWith(".tar.gz");
  });

  test("custom version in cache path", () => {
    const path = getCachePath("v1.120.0");
    expect(path).toContain("v1.120.0");
  });
});
