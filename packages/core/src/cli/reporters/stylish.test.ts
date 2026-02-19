import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { formatStylish, formatSummary, formatJson, formatSarif } from "./stylish";
import type { LintDiagnostic } from "../../lint/rule";

describe("formatStylish", () => {
  const originalNoColor = process.env.NO_COLOR;

  beforeEach(() => {
    process.env.NO_COLOR = "1"; // Disable colors for testing
  });

  afterEach(() => {
    if (originalNoColor !== undefined) {
      process.env.NO_COLOR = originalNoColor;
    } else {
      delete process.env.NO_COLOR;
    }
  });

  test("returns empty string for no diagnostics", () => {
    const result = formatStylish([]);
    expect(result).toBe("");
  });

  test("formats single diagnostic", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 10,
        column: 5,
        ruleId: "COR001",
        severity: "warning",
        message: "Something is wrong",
      },
    ];

    const result = formatStylish(diagnostics);

    expect(result).toContain("test.ts");
    expect(result).toContain("10");
    expect(result).toContain("5");
    expect(result).toContain("warning");
    expect(result).toContain("Something is wrong");
    expect(result).toContain("COR001");
  });

  test("groups diagnostics by file", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "a.ts",
        line: 1,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Issue 1",
      },
      {
        file: "b.ts",
        line: 1,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Issue 2",
      },
      {
        file: "a.ts",
        line: 2,
        column: 1,
        ruleId: "COR001",
        severity: "error",
        message: "Issue 3",
      },
    ];

    const result = formatStylish(diagnostics);

    // Both files should appear
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");

    // Summary should show 1 error, 2 warnings
    expect(result).toContain("1 error");
    expect(result).toContain("2 warnings");
  });

  test("sorts diagnostics by line then column", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 20,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Line 20",
      },
      {
        file: "test.ts",
        line: 10,
        column: 5,
        ruleId: "COR001",
        severity: "warning",
        message: "Line 10 col 5",
      },
      {
        file: "test.ts",
        line: 10,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Line 10 col 1",
      },
    ];

    const result = formatStylish(diagnostics);
    const lines = result.split("\n");

    // Find the diagnostic lines (contain "warning")
    const diagLines = lines.filter((l) => l.includes("warning"));

    expect(diagLines[0]).toContain("Line 10 col 1");
    expect(diagLines[1]).toContain("Line 10 col 5");
    expect(diagLines[2]).toContain("Line 20");
  });
});

describe("formatSummary", () => {
  beforeEach(() => {
    process.env.NO_COLOR = "1";
  });

  test("formats errors only", () => {
    const result = formatSummary(3, 0);
    expect(result).toContain("3 errors");
  });

  test("formats warnings only", () => {
    const result = formatSummary(0, 2);
    expect(result).toContain("2 warnings");
  });

  test("formats both errors and warnings", () => {
    const result = formatSummary(1, 2);
    expect(result).toContain("1 error");
    expect(result).toContain("2 warnings");
  });

  test("formats no problems", () => {
    const result = formatSummary(0, 0);
    expect(result).toContain("No problems");
  });

  test("uses singular for 1 error", () => {
    const result = formatSummary(1, 0);
    expect(result).toContain("1 error");
    expect(result).not.toContain("1 errors");
  });

  test("uses singular for 1 warning", () => {
    const result = formatSummary(0, 1);
    expect(result).toContain("1 warning");
    expect(result).not.toContain("1 warnings");
  });
});

describe("formatJson", () => {
  test("returns valid JSON", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 10,
        column: 5,
        ruleId: "COR001",
        severity: "warning",
        message: "Something is wrong",
      },
    ];

    const result = formatJson(diagnostics);

    expect(() => JSON.parse(result)).not.toThrow();

    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].file).toBe("test.ts");
  });
});

describe("formatSarif", () => {
  test("returns valid SARIF JSON", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 10,
        column: 5,
        ruleId: "COR001",
        severity: "warning",
        message: "Something is wrong",
      },
    ];

    const result = formatSarif(diagnostics);

    expect(() => JSON.parse(result)).not.toThrow();

    const parsed = JSON.parse(result);
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].tool.driver.name).toBe("chant");
    expect(parsed.runs[0].results).toHaveLength(1);
  });

  test("maps severity correctly", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 1,
        column: 1,
        ruleId: "E001",
        severity: "error",
        message: "Error",
      },
      {
        file: "test.ts",
        line: 2,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Warning",
      },
      {
        file: "test.ts",
        line: 3,
        column: 1,
        ruleId: "I001",
        severity: "info",
        message: "Info",
      },
    ];

    const result = formatSarif(diagnostics);
    const parsed = JSON.parse(result);

    expect(parsed.runs[0].results[0].level).toBe("error");
    expect(parsed.runs[0].results[1].level).toBe("warning");
    expect(parsed.runs[0].results[2].level).toBe("note");
  });

  test("extracts unique rules", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "a.ts",
        line: 1,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Issue 1",
      },
      {
        file: "b.ts",
        line: 1,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Issue 2",
      },
      {
        file: "c.ts",
        line: 1,
        column: 1,
        ruleId: "COR008",
        severity: "warning",
        message: "Issue 3",
      },
    ];

    const result = formatSarif(diagnostics);
    const parsed = JSON.parse(result);

    // Should have 2 unique rules
    expect(parsed.runs[0].tool.driver.rules).toHaveLength(2);
  });
});
