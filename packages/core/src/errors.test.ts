import { describe, test, expect } from "bun:test";
import { DiscoveryError, BuildError, LintError } from "./errors";

describe("DiscoveryError", () => {
  test("creates error with file, message, and type properties", () => {
    const error = new DiscoveryError(
      "/path/to/file.ts",
      "Failed to import module",
      "import"
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DiscoveryError);
    expect(error.name).toBe("DiscoveryError");
    expect(error.file).toBe("/path/to/file.ts");
    expect(error.message).toBe("Failed to import module");
    expect(error.type).toBe("import");
  });

  test("supports resolution error type", () => {
    const error = new DiscoveryError(
      "/src/index.ts",
      "Cannot resolve module",
      "resolution"
    );

    expect(error.type).toBe("resolution");
  });

  test("supports circular error type", () => {
    const error = new DiscoveryError(
      "/src/circular.ts",
      "Circular dependency detected",
      "circular"
    );

    expect(error.type).toBe("circular");
  });

  test("serializes to JSON correctly", () => {
    const error = new DiscoveryError(
      "/test.ts",
      "Test error",
      "import"
    );

    const json = error.toJSON();
    expect(json).toEqual({
      name: "DiscoveryError",
      file: "/test.ts",
      message: "Test error",
      type: "import",
    });
  });
});

describe("BuildError", () => {
  test("creates error with entityName and message properties", () => {
    const error = new BuildError("MyEntity", "Failed to build entity");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(BuildError);
    expect(error.name).toBe("BuildError");
    expect(error.entityName).toBe("MyEntity");
    expect(error.message).toBe("Failed to build entity");
  });

  test("serializes to JSON correctly", () => {
    const error = new BuildError("TestEntity", "Serialization failed");

    const json = error.toJSON();
    expect(json).toEqual({
      name: "BuildError",
      entityName: "TestEntity",
      message: "Serialization failed",
    });
  });

  test("handles entity names with special characters", () => {
    const error = new BuildError("My-Entity_v2", "Build failure");

    expect(error.entityName).toBe("My-Entity_v2");
  });
});

describe("LintError", () => {
  test("creates error with file, line, column, ruleId, and message properties", () => {
    const error = new LintError(
      "/src/app.ts",
      42,
      10,
      "no-unused-vars",
      "Variable 'x' is declared but never used"
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(LintError);
    expect(error.name).toBe("LintError");
    expect(error.file).toBe("/src/app.ts");
    expect(error.line).toBe(42);
    expect(error.column).toBe(10);
    expect(error.ruleId).toBe("no-unused-vars");
    expect(error.message).toBe("Variable 'x' is declared but never used");
  });

  test("handles line 0 and column 0", () => {
    const error = new LintError(
      "/test.ts",
      0,
      0,
      "parse-error",
      "Parse error"
    );

    expect(error.line).toBe(0);
    expect(error.column).toBe(0);
  });

  test("serializes to JSON correctly", () => {
    const error = new LintError(
      "/main.ts",
      15,
      3,
      "@typescript-eslint/no-explicit-any",
      "Unexpected any"
    );

    const json = error.toJSON();
    expect(json).toEqual({
      name: "LintError",
      file: "/main.ts",
      line: 15,
      column: 3,
      ruleId: "@typescript-eslint/no-explicit-any",
      message: "Unexpected any",
    });
  });
});
