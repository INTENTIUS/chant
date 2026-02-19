import { describe, test, expect } from "bun:test";
import { toCamelCase, toPascalCase } from "./case";

describe("toCamelCase", () => {
  test("lowercases first character", () => {
    expect(toCamelCase("BucketName")).toBe("bucketName");
  });

  test("preserves already-camelCase", () => {
    expect(toCamelCase("already")).toBe("already");
  });

  test("handles single character", () => {
    expect(toCamelCase("A")).toBe("a");
  });
});

describe("toPascalCase", () => {
  test("uppercases first character", () => {
    expect(toPascalCase("bucketName")).toBe("BucketName");
  });

  test("preserves already-PascalCase", () => {
    expect(toPascalCase("Already")).toBe("Already");
  });

  test("handles single character", () => {
    expect(toPascalCase("a")).toBe("A");
  });
});
