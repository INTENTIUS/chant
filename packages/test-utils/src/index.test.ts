import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTestDir,
  cleanupTestDir,
  withTestDir,
  createMockEntity,
  createMockSerializer,
  createMockLintRule,
  createMockLintContext,
  expectToThrow,
} from "./index";
import { DECLARABLE_MARKER } from "../../core/src/declarable";

describe("fs utilities", () => {
  describe("createTestDir", () => {
    test("creates a unique temporary directory", async () => {
      const dir = await createTestDir();
      expect(existsSync(dir)).toBe(true);
      await cleanupTestDir(dir);
    });

    test("uses custom prefix", async () => {
      const dir = await createTestDir("custom-prefix");
      expect(dir).toContain("custom-prefix");
      await cleanupTestDir(dir);
    });

    test("creates unique directories on multiple calls", async () => {
      const dir1 = await createTestDir();
      const dir2 = await createTestDir();
      expect(dir1).not.toBe(dir2);
      await cleanupTestDir(dir1);
      await cleanupTestDir(dir2);
    });
  });

  describe("cleanupTestDir", () => {
    test("removes directory", async () => {
      const dir = await createTestDir();
      await cleanupTestDir(dir);
      expect(existsSync(dir)).toBe(false);
    });

    test("removes directory with contents", async () => {
      const dir = await createTestDir();
      const file = join(dir, "test.txt");
      await writeFile(file, "test content");
      await cleanupTestDir(dir);
      expect(existsSync(dir)).toBe(false);
    });
  });

  describe("withTestDir", () => {
    test("creates directory, runs function, and cleans up", async () => {
      let capturedDir: string | null = null;
      const result = await withTestDir(async (dir) => {
        capturedDir = dir;
        expect(existsSync(dir)).toBe(true);
        return 42;
      });

      expect(result).toBe(42);
      expect(capturedDir).not.toBeNull();
      expect(existsSync(capturedDir!)).toBe(false);
    });

    test("cleans up even if function throws", async () => {
      let capturedDir: string | null = null;

      try {
        await withTestDir(async (dir) => {
          capturedDir = dir;
          throw new Error("Test error");
        });
      } catch (error) {
        expect((error as Error).message).toBe("Test error");
      }

      expect(capturedDir).not.toBeNull();
      expect(existsSync(capturedDir!)).toBe(false);
    });

    test("supports custom prefix", async () => {
      await withTestDir(async (dir) => {
        expect(dir).toContain("my-test");
      }, "my-test");
    });
  });
});

describe("fixture utilities", () => {
  describe("createMockEntity", () => {
    test("creates entity with default type", () => {
      const entity = createMockEntity();
      expect(entity.entityType).toBe("TestEntity");
      expect(entity[DECLARABLE_MARKER]).toBe(true);
    });

    test("creates entity with custom type", () => {
      const entity = createMockEntity("CustomType");
      expect(entity.entityType).toBe("CustomType");
      expect(entity[DECLARABLE_MARKER]).toBe(true);
    });
  });

  describe("createMockSerializer", () => {
    test("creates serializer with default name", () => {
      const serializer = createMockSerializer();
      expect(serializer.name).toBe("test");
      expect(serializer.rulePrefix).toBe("TEST");
    });

    test("creates serializer with custom name", () => {
      const serializer = createMockSerializer("custom");
      expect(serializer.name).toBe("custom");
      expect(serializer.rulePrefix).toBe("CUSTOM");
    });

    test("serialize method works", () => {
      const serializer = createMockSerializer();
      const entities = new Map();
      entities.set("entity1", createMockEntity("Type1"));
      entities.set("entity2", createMockEntity("Type2"));

      const result = serializer.serialize(entities);
      const parsed = JSON.parse(result);

      expect(parsed.resources.entity1.type).toBe("Type1");
      expect(parsed.resources.entity2.type).toBe("Type2");
    });
  });

  describe("createMockLintRule", () => {
    test("creates rule with default id", () => {
      const rule = createMockLintRule();
      expect(rule.id).toBe("test-rule");
      expect(rule.severity).toBe("error");
      expect(rule.category).toBe("correctness");
    });

    test("creates rule with custom id", () => {
      const rule = createMockLintRule("custom-rule");
      expect(rule.id).toBe("custom-rule");
    });

    test("check method returns provided diagnostics", () => {
      const diagnostics = [
        {
          file: "test.ts",
          line: 1,
          column: 1,
          ruleId: "test-rule",
          severity: "error" as const,
          message: "Test error",
        },
      ];
      const rule = createMockLintRule("test-rule", diagnostics);
      const context = createMockLintContext("const x = 1;");
      const result = rule.check(context);
      expect(result).toBe(diagnostics);
    });
  });

  describe("createMockLintContext", () => {
    test("creates context with default file path", () => {
      const context = createMockLintContext("const x = 1;");
      expect(context.filePath).toBe("test.ts");
      expect(context.sourceFile).toBeDefined();
      expect(context.entities).toEqual([]);
    });

    test("creates context with custom file path", () => {
      const context = createMockLintContext("const x = 1;", "custom.ts");
      expect(context.filePath).toBe("custom.ts");
    });

    test("parses source code correctly", () => {
      const code = "const x = 1;\nconst y = 2;";
      const context = createMockLintContext(code);
      expect(context.sourceFile.text).toBe(code);
    });
  });
});

describe("assertion utilities", () => {
  describe("expectToThrow", () => {
    test("succeeds when function throws expected error", async () => {
      const error = await expectToThrow(
        () => {
          throw new Error("Test error");
        },
        Error
      );
      expect(error.message).toBe("Test error");
    });

    test("succeeds with async function", async () => {
      const error = await expectToThrow(
        async () => {
          throw new Error("Async error");
        },
        Error
      );
      expect(error.message).toBe("Async error");
    });

    test("fails when function does not throw", async () => {
      try {
        await expectToThrow(() => {
          return 42;
        }, Error);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain("did not throw");
      }
    });

    test("fails when function throws wrong error type", async () => {
      class CustomError extends Error {}

      try {
        await expectToThrow(
          () => {
            throw new Error("Wrong type");
          },
          CustomError
        );
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain("CustomError");
      }
    });

    test("supports validation function", async () => {
      const error = await expectToThrow(
        () => {
          const e = new Error("Test error");
          (e as Error & { code: string }).code = "TEST_CODE";
          throw e;
        },
        Error,
        (e) => {
          expect((e as Error & { code: string }).code).toBe("TEST_CODE");
        }
      );
      expect(error.message).toBe("Test error");
    });

    test("validates with custom error class", async () => {
      class ValidationError extends Error {
        constructor(
          message: string,
          public code: string
        ) {
          super(message);
        }
      }

      const error = await expectToThrow(
        () => {
          throw new ValidationError("Validation failed", "VAL_001");
        },
        ValidationError,
        (e) => {
          expect(e.code).toBe("VAL_001");
        }
      );
      expect(error.message).toBe("Validation failed");
    });
  });
});
