import { describe, test, expect } from "bun:test";
import { generateDocs } from "./docs";

describe("generateDocs", () => {
  test("generateDocs function exists and is callable", () => {
    expect(typeof generateDocs).toBe("function");
  });

  test("generateDocs returns a promise", () => {
    const result = generateDocs({ verbose: false });
    expect(result).toBeDefined();
    expect(typeof result.then).toBe("function");
    // Suppress unhandled rejection if it fails due to missing data
    result.catch(() => {});
  });
});
