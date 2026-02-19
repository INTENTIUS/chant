import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  formatError,
  formatWarning,
  formatSuccess,
  formatInfo,
  formatBold,
} from "./format";

describe("formatError", () => {
  // Save original env
  const originalNoColor = process.env.NO_COLOR;

  beforeEach(() => {
    // Enable colors for testing
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    // Restore original env
    if (originalNoColor !== undefined) {
      process.env.NO_COLOR = originalNoColor;
    } else {
      delete process.env.NO_COLOR;
    }
  });

  test("formats error with file, line, and column", () => {
    const result = formatError({
      file: "test.ts",
      line: 10,
      column: 5,
      message: "Something went wrong",
    });

    expect(result).toContain("test.ts:10:5");
    expect(result).toContain("error");
    expect(result).toContain("Something went wrong");
  });

  test("formats error with file and line only", () => {
    const result = formatError({
      file: "test.ts",
      line: 10,
      message: "Something went wrong",
    });

    expect(result).toContain("test.ts:10");
    expect(result).not.toContain("test.ts:10:");
    expect(result).toContain("error");
  });

  test("formats error with file only", () => {
    const result = formatError({
      file: "test.ts",
      message: "Something went wrong",
    });

    expect(result).toContain("test.ts");
    expect(result).toContain("error");
  });

  test("formats error with message only", () => {
    const result = formatError({
      message: "Something went wrong",
    });

    expect(result).toContain("error");
    expect(result).toContain("Something went wrong");
    // Should not have file location prefix (no " - " before error)
    expect(result).not.toContain(" - ");
  });

  test("respects NO_COLOR environment variable", () => {
    process.env.NO_COLOR = "1";

    const result = formatError({
      file: "test.ts",
      line: 10,
      message: "Something went wrong",
    });

    // Should not contain ANSI escape codes
    expect(result).not.toContain("\x1b[");
    expect(result).toContain("test.ts:10");
    expect(result).toContain("error");
  });
});

describe("formatWarning", () => {
  beforeEach(() => {
    delete process.env.NO_COLOR;
  });

  test("formats warning with location", () => {
    const result = formatWarning({
      file: "test.ts",
      line: 10,
      column: 5,
      message: "Potential issue",
    });

    expect(result).toContain("test.ts:10:5");
    expect(result).toContain("warning");
    expect(result).toContain("Potential issue");
  });

  test("formats warning with message only", () => {
    const result = formatWarning({
      message: "Potential issue",
    });

    expect(result).toContain("warning");
    expect(result).toContain("Potential issue");
  });
});

describe("formatSuccess", () => {
  test("formats success message", () => {
    const result = formatSuccess("Build complete");

    expect(result).toContain("Build complete");
  });
});

describe("formatInfo", () => {
  test("formats info message", () => {
    const result = formatInfo("Processing files...");

    expect(result).toContain("Processing files...");
  });
});

describe("formatBold", () => {
  test("formats bold text", () => {
    const result = formatBold("Important");

    expect(result).toContain("Important");
  });
});
