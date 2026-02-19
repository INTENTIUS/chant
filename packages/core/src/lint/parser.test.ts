import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { parseFile } from "./parser";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import * as ts from "typescript";

const TEST_DIR = join(import.meta.dir, "__test_parser__");
const VALID_FILE = join(TEST_DIR, "valid.ts");
const INVALID_FILE = join(TEST_DIR, "invalid.ts");
const NONEXISTENT_FILE = join(TEST_DIR, "nonexistent.ts");

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });

  // Create a valid TypeScript file
  writeFileSync(
    VALID_FILE,
    `export interface User {
  name: string;
  age: number;
}

export function greet(user: User): string {
  return \`Hello, \${user.name}!\`;
}
`
  );

  // Create an invalid TypeScript file (syntax error)
  writeFileSync(
    INVALID_FILE,
    `export interface User {
  name: string
  age: number // missing semicolon is ok, but let's make a real syntax error
}

export function broken( {
  return "missing closing paren and body";
`
  );
});

afterAll(() => {
  try {
    unlinkSync(VALID_FILE);
  } catch {}
  try {
    unlinkSync(INVALID_FILE);
  } catch {}
  try {
    unlinkSync(NONEXISTENT_FILE);
  } catch {}
});

describe("parseFile", () => {
  test("parses valid TypeScript file and returns SourceFile", () => {
    const sourceFile = parseFile(VALID_FILE);

    expect(sourceFile).toBeDefined();
    expect(sourceFile.fileName).toBe(VALID_FILE);
    expect(sourceFile.kind).toBe(ts.SyntaxKind.SourceFile);
  });

  test("returns SourceFile with expected structure", () => {
    const sourceFile = parseFile(VALID_FILE);

    // Should have statements (interface and function declarations)
    expect(sourceFile.statements.length).toBeGreaterThan(0);

    // First statement should be interface declaration
    const firstStatement = sourceFile.statements[0];
    expect(firstStatement.kind).toBe(ts.SyntaxKind.InterfaceDeclaration);

    // Second statement should be function declaration
    const secondStatement = sourceFile.statements[1];
    expect(secondStatement.kind).toBe(ts.SyntaxKind.FunctionDeclaration);
  });

  test("sets parent nodes correctly", () => {
    const sourceFile = parseFile(VALID_FILE);

    // Check that parent nodes are set
    const firstStatement = sourceFile.statements[0];
    expect(firstStatement.parent).toBe(sourceFile);
  });

  test("throws clear error for invalid TypeScript", () => {
    expect(() => parseFile(INVALID_FILE)).toThrow("TypeScript parsing failed");
  });

  test("throws error with file location for syntax errors", () => {
    try {
      parseFile(INVALID_FILE);
      expect.unreachable("Should have thrown an error");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const error = err as Error;
      expect(error.message).toContain(INVALID_FILE);
      expect(error.message).toContain("TypeScript parsing failed");
    }
  });

  test("throws clear error when file does not exist", () => {
    expect(() => parseFile(NONEXISTENT_FILE)).toThrow("Failed to read file");
    expect(() => parseFile(NONEXISTENT_FILE)).toThrow(NONEXISTENT_FILE);
  });

  test("handles empty file", () => {
    const emptyFile = join(TEST_DIR, "empty.ts");
    writeFileSync(emptyFile, "");

    const sourceFile = parseFile(emptyFile);
    expect(sourceFile).toBeDefined();
    expect(sourceFile.statements.length).toBe(0);

    unlinkSync(emptyFile);
  });

  test("handles file with only comments", () => {
    const commentsFile = join(TEST_DIR, "comments.ts");
    writeFileSync(commentsFile, "// Just a comment\n/* Another comment */");

    const sourceFile = parseFile(commentsFile);
    expect(sourceFile).toBeDefined();
    expect(sourceFile.statements.length).toBe(0);

    unlinkSync(commentsFile);
  });
});
