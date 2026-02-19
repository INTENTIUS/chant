import { describe, test, expect } from "bun:test";
import { runLint } from "./engine";
import type { LintRule, LintContext, LintDiagnostic } from "./rule";
import { withTestDir } from "@intentius/chant-test-utils";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("runLint", () => {
  test("executes rules and returns diagnostics", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "test.ts");
      await writeFile(testFile, "const x = 1;");

      const mockRule: LintRule = {
        id: "test-rule",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 1,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule]);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("test-rule");
      expect(diagnostics[0].message).toBe("Test error");
    });
  });

  test("supports file-level disable comment for all rules", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "test.ts");
      await writeFile(
        testFile,
        `// chant-disable
const x = 1;`
      );

      const mockRule: LintRule = {
        id: "test-rule",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule]);

      expect(diagnostics).toHaveLength(0);
    });
  });

  test("supports file-level disable comment for specific rules", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "test.ts");
      await writeFile(
        testFile,
        `// chant-disable test-rule-1
const x = 1;`
      );

      const mockRule1: LintRule = {
        id: "test-rule-1",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule-1",
              severity: "error",
              message: "Test error 1",
            },
          ];
        },
      };

      const mockRule2: LintRule = {
        id: "test-rule-2",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule-2",
              severity: "error",
              message: "Test error 2",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule1, mockRule2]);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("test-rule-2");
    });
  });

  test("supports disable-line comment", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "test.ts");
      await writeFile(
        testFile,
        `const x = 1; // chant-disable-line
const y = 2;`
      );

      const mockRule: LintRule = {
        id: "test-rule",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 1,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error line 1",
            },
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error line 2",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule]);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].line).toBe(2);
    });
  });

  test("supports disable-next-line comment", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "test.ts");
      await writeFile(
        testFile,
        `// chant-disable-next-line
const x = 1;
const y = 2;`
      );

      const mockRule: LintRule = {
        id: "test-rule",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error line 2",
            },
            {
              file: context.filePath,
              line: 3,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error line 3",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule]);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].line).toBe(3);
    });
  });

  test("supports disable-line with specific rule", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "test.ts");
      await writeFile(testFile, `const x = 1; // chant-disable-line test-rule-1`);

      const mockRule1: LintRule = {
        id: "test-rule-1",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 1,
              column: 1,
              ruleId: "test-rule-1",
              severity: "error",
              message: "Test error 1",
            },
          ];
        },
      };

      const mockRule2: LintRule = {
        id: "test-rule-2",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 1,
              column: 1,
              ruleId: "test-rule-2",
              severity: "error",
              message: "Test error 2",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule1, mockRule2]);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("test-rule-2");
    });
  });

  test("ignores non-existent rule IDs in disable comments", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "test.ts");
      await writeFile(
        testFile,
        `// chant-disable non-existent-rule
const x = 1;`
      );

      const mockRule: LintRule = {
        id: "test-rule",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule]);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("test-rule");
    });
  });

  test("supports multiple disable comments for same rule", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "test.ts");
      await writeFile(
        testFile,
        `// chant-disable-next-line test-rule
const x = 1;
// chant-disable-next-line test-rule
const y = 2;
const z = 3;`
      );

      const mockRule: LintRule = {
        id: "test-rule",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error line 2",
            },
            {
              file: context.filePath,
              line: 4,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error line 4",
            },
            {
              file: context.filePath,
              line: 5,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error line 5",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule]);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].line).toBe(5);
    });
  });

  test("processes multiple files", async () => {
    await withTestDir(async (testDir) => {
      const testFile1 = join(testDir, "test1.ts");
      const testFile2 = join(testDir, "test2.ts");
      await writeFile(testFile1, "const x = 1;");
      await writeFile(testFile2, "const y = 2;");

      const mockRule: LintRule = {
        id: "test-rule",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 1,
              column: 1,
              ruleId: "test-rule",
              severity: "error",
              message: "Test error",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile1, testFile2], [mockRule]);

      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.map((d) => d.file).sort()).toEqual([testFile1, testFile2].sort());
    });
  });

  test("handles parsing errors gracefully", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "invalid.ts");
      await writeFile(testFile, "const x = ;");

      const mockRule: LintRule = {
        id: "test-rule",
        severity: "error",
        category: "correctness",
        check: (): LintDiagnostic[] => {
          return [];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule]);
      expect(diagnostics).toHaveLength(0);
    });
  });

  test("supports multiple rules with disable comment", async () => {
    await withTestDir(async (testDir) => {
      const testFile = join(testDir, "test.ts");
      await writeFile(
        testFile,
        `// chant-disable test-rule-1 test-rule-2
const x = 1;`
      );

      const mockRule1: LintRule = {
        id: "test-rule-1",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule-1",
              severity: "error",
              message: "Test error 1",
            },
          ];
        },
      };

      const mockRule2: LintRule = {
        id: "test-rule-2",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule-2",
              severity: "error",
              message: "Test error 2",
            },
          ];
        },
      };

      const mockRule3: LintRule = {
        id: "test-rule-3",
        severity: "error",
        category: "correctness",
        check: (context: LintContext): LintDiagnostic[] => {
          return [
            {
              file: context.filePath,
              line: 2,
              column: 1,
              ruleId: "test-rule-3",
              severity: "error",
              message: "Test error 3",
            },
          ];
        },
      };

      const diagnostics = await runLint([testFile], [mockRule1, mockRule2, mockRule3]);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("test-rule-3");
    });
  });
});
