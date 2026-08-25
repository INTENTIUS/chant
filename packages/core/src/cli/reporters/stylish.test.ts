import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { formatStylish, formatSummary, formatJson, formatSarif } from "./stylish";
import type { LintDiagnostic, LintRule } from "../../lint/rule";
import type { OkfBundle, OkfConcept } from "../../okf-read";

function concept(overrides: Partial<OkfConcept> & { path: string }): OkfConcept {
  return {
    type: "decision",
    binds: [],
    frontmatter: {},
    body: "",
    ...overrides,
  };
}

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

  test("returns summary line for no diagnostics", () => {
    const result = formatStylish([]);
    expect(result).toBe("\u2713 No problems found");
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

describe("formatStylish suppressed section (#1866, design #1059)", () => {
  beforeEach(() => {
    process.env.NO_COLOR = "1";
  });
  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  const suppressedDiag: LintDiagnostic & { reason?: string } = {
    file: "src/storage.ts",
    line: 12,
    column: 1,
    ruleId: "AWS021",
    severity: "warning",
    message: "Bucket ACL is public-read",
  };

  test("no section when there are no suppressed diagnostics", () => {
    const result = formatStylish([], []);
    expect(result).not.toContain("Suppressed");
  });

  test("renders a Suppressed section when suppressed diagnostics exist", () => {
    const result = formatStylish([], [{ ...suppressedDiag, reason: "backwards compat" }]);

    expect(result).toContain("Suppressed");
    expect(result).toContain("src/storage.ts");
    expect(result).toContain("AWS021");
    expect(result).toContain("backwards compat");
  });

  test("renders the section even when there are no active diagnostics", () => {
    const result = formatStylish([], [suppressedDiag]);
    expect(result).toContain("Suppressed");
    // No active errors/warnings were counted from a suppressed diagnostic
    expect(result).toContain("No problems found");
  });

  test("an okf: citation resolves to the concept's title and bundle-relative path", () => {
    const bundle: OkfBundle = {
      concepts: [
        concept({
          path: "decisions/public-assets.md",
          title: "Public asset bucket stays world-readable",
        }),
      ],
    };

    const result = formatStylish(
      [],
      [{ ...suppressedDiag, reason: "okf:/decisions/public-assets.md" }],
      bundle,
    );

    expect(result).toContain("Public asset bucket stays world-readable");
    expect(result).toContain("decisions/public-assets.md");
    expect(result).not.toContain("okf:/decisions/public-assets.md");
  });

  test("also resolves a citation without a leading slash", () => {
    const bundle: OkfBundle = {
      concepts: [concept({ path: "decisions/public-assets.md", title: "Public assets" })],
    };

    const result = formatStylish(
      [],
      [{ ...suppressedDiag, reason: "okf:decisions/public-assets.md" }],
      bundle,
    );

    expect(result).toContain("Public assets");
  });

  test("an unresolvable citation prints the raw reason with a warning", () => {
    const bundle: OkfBundle = { concepts: [] };

    const result = formatStylish(
      [],
      [{ ...suppressedDiag, reason: "okf:/decisions/does-not-exist.md" }],
      bundle,
    );

    expect(result).toContain("okf:/decisions/does-not-exist.md");
    expect(result).toContain("unresolved okf citation");
  });

  test("an okf: citation with no bundle loaded prints the raw reason with a warning", () => {
    const result = formatStylish([], [{ ...suppressedDiag, reason: "okf:/decisions/public-assets.md" }]);

    expect(result).toContain("okf:/decisions/public-assets.md");
    expect(result).toContain("unresolved okf citation");
  });

  test("a plain (non-okf) reason renders as-is, unaffected by a loaded bundle", () => {
    const bundle: OkfBundle = {
      concepts: [concept({ path: "decisions/public-assets.md", title: "Public assets" })],
    };

    const result = formatStylish([], [{ ...suppressedDiag, reason: "grandfathered, see #412" }], bundle);

    expect(result).toContain("grandfathered, see #412");
    expect(result).not.toContain("Public assets");
  });

  test("a suppressed diagnostic with no reason still renders", () => {
    const result = formatStylish([], [suppressedDiag]);
    expect(result).toContain("AWS021");
    expect(result).toContain("suppressed");
  });

  test("active diagnostics and the suppressed section coexist", () => {
    const active: LintDiagnostic = {
      file: "src/other.ts",
      line: 1,
      column: 1,
      ruleId: "COR001",
      severity: "error",
      message: "Active problem",
    };

    const result = formatStylish([active], [{ ...suppressedDiag, reason: "okf:/decisions/public-assets.md" }], {
      concepts: [concept({ path: "decisions/public-assets.md", title: "Public assets" })],
    });

    expect(result).toContain("src/other.ts");
    expect(result).toContain("Active problem");
    expect(result).toContain("1 error");
    expect(result).toContain("Suppressed");
    expect(result).toContain("Public assets");
  });

  test("a title-less resolved concept falls back to its path as the label", () => {
    const bundle: OkfBundle = {
      concepts: [concept({ path: "decisions/public-assets.md" })],
    };

    const result = formatStylish([], [{ ...suppressedDiag, reason: "okf:/decisions/public-assets.md" }], bundle);

    expect(result).toContain("decisions/public-assets.md");
    expect(result).not.toContain("unresolved");
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

  test("enriches rules with descriptions when LintRule objects are provided", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 1,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Issue",
      },
    ];

    const rules: LintRule[] = [
      {
        id: "COR001",
        severity: "warning",
        category: "style",
        description: "No inline objects in Declarable constructors",
        check: () => [],
      },
    ];

    const result = formatSarif(diagnostics, rules);
    const parsed = JSON.parse(result);
    const sarifRule = parsed.runs[0].tool.driver.rules[0];

    expect(sarifRule.shortDescription.text).toBe("No inline objects in Declarable constructors");
    expect(sarifRule.fullDescription.text).toBe("No inline objects in Declarable constructors");
    expect(sarifRule.helpUri).toContain("cor001");
    expect(sarifRule.defaultConfiguration.level).toBe("warning");
    expect(sarifRule.properties.category).toBe("style");
  });

  test("includes fingerprints in results", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 10,
        column: 5,
        ruleId: "COR001",
        severity: "warning",
        message: "Something",
      },
    ];

    const result = formatSarif(diagnostics);
    const parsed = JSON.parse(result);

    expect(parsed.runs[0].results[0].fingerprints).toBeDefined();
    expect(parsed.runs[0].results[0].fingerprints["chant/v1"]).toBe("COR001:test.ts:10:5");
  });

  test("includes ruleIndex in results", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 1,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Issue",
      },
    ];

    const result = formatSarif(diagnostics);
    const parsed = JSON.parse(result);

    expect(parsed.runs[0].results[0].ruleIndex).toBe(0);
  });

  test("includes endLine/endColumn when provided", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 10,
        column: 5,
        endLine: 12,
        endColumn: 20,
        ruleId: "COR001",
        severity: "warning",
        message: "Something",
      },
    ];

    const result = formatSarif(diagnostics);
    const parsed = JSON.parse(result);
    const region = parsed.runs[0].results[0].locations[0].physicalLocation.region;

    expect(region.startLine).toBe(10);
    expect(region.startColumn).toBe(5);
    expect(region.endLine).toBe(12);
    expect(region.endColumn).toBe(20);
  });

  test("omits endLine/endColumn when not provided", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 10,
        column: 5,
        ruleId: "COR001",
        severity: "warning",
        message: "Something",
      },
    ];

    const result = formatSarif(diagnostics);
    const parsed = JSON.parse(result);
    const region = parsed.runs[0].results[0].locations[0].physicalLocation.region;

    expect(region.endLine).toBeUndefined();
    expect(region.endColumn).toBeUndefined();
  });

  test("includes suppressed diagnostics with suppressions array", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 1,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Active issue",
      },
    ];

    const suppressed: Array<LintDiagnostic & { reason?: string }> = [
      {
        file: "test.ts",
        line: 5,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Suppressed issue",
        reason: "backwards compat",
      },
    ];

    const result = formatSarif(diagnostics, undefined, suppressed);
    const parsed = JSON.parse(result);

    // Should have 2 results total (1 active + 1 suppressed)
    expect(parsed.runs[0].results).toHaveLength(2);

    // First result: no suppressions
    expect(parsed.runs[0].results[0].suppressions).toBeUndefined();

    // Second result: has suppressions
    expect(parsed.runs[0].results[1].suppressions).toHaveLength(1);
    expect(parsed.runs[0].results[1].suppressions[0].kind).toBe("inSource");
    expect(parsed.runs[0].results[1].suppressions[0].justification).toBe("backwards compat");
  });

  test("suppressed diagnostics without reason omit justification", () => {
    const suppressed: Array<LintDiagnostic & { reason?: string }> = [
      {
        file: "test.ts",
        line: 5,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Suppressed issue",
      },
    ];

    const result = formatSarif([], undefined, suppressed);
    const parsed = JSON.parse(result);

    expect(parsed.runs[0].results[0].suppressions[0].kind).toBe("inSource");
    expect(parsed.runs[0].results[0].suppressions[0].justification).toBeUndefined();
  });

  test("falls back to rule ID when no description available", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "test.ts",
        line: 1,
        column: 1,
        ruleId: "UNKNOWN",
        severity: "warning",
        message: "Issue",
      },
    ];

    const result = formatSarif(diagnostics);
    const parsed = JSON.parse(result);
    const sarifRule = parsed.runs[0].tool.driver.rules[0];

    expect(sarifRule.shortDescription.text).toBe("UNKNOWN");
    expect(sarifRule.helpUri).toContain("unknown");
  });

  test("converts absolute file paths to file:// URIs", () => {
    const diagnostics: LintDiagnostic[] = [
      {
        file: "/Users/test/project/test.ts",
        line: 1,
        column: 1,
        ruleId: "COR001",
        severity: "warning",
        message: "Issue",
      },
    ];

    const result = formatSarif(diagnostics);
    const parsed = JSON.parse(result);
    const uri = parsed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;

    expect(uri).toMatch(/^file:\/\//);
  });
});
