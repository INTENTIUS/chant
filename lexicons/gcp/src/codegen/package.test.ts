import { describe, test, expect } from "vitest";
import { packageLexicon } from "./package";

describe("packageLexicon", () => {
  test("packageLexicon function exists and is callable", () => {
    expect(typeof packageLexicon).toBe("function");
  });

  test("packageLexicon returns a promise", () => {
    const result = packageLexicon({ verbose: false });
    expect(result).toBeDefined();
    expect(typeof result.then).toBe("function");
    // Suppress unhandled rejection if it fails due to missing artifacts
    result.catch(() => {});
  });
});
