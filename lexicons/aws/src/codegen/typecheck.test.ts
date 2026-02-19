import { describe, test, expect } from "bun:test";
import { typecheckDTS } from "./typecheck";

describe("typecheckDTS", () => {
  test("passes valid .d.ts", async () => {
    const content = `
      export declare class Bucket {
        readonly type: string;
        readonly bucketName?: string;
      }
    `;
    const result = await typecheckDTS(content);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  test("fails on undefined type reference", async () => {
    const content = `
      export declare class Broken {
        readonly value: UndefinedType;
      }
    `;
    const result = await typecheckDTS(content);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("fails on syntax error", async () => {
    const content = `
      export declare class {
        this is not valid typescript
      }
    `;
    const result = await typecheckDTS(content);
    expect(result.ok).toBe(false);
  });

  test("passes fixture-generated .d.ts", async () => {
    const { loadSchemaFixtures } = await import("../testdata/load-fixtures");
    const { generate } = await import("./generate");
    const fixtures = loadSchemaFixtures();
    const genResult = await generate({ schemaSource: fixtures });

    const result = await typecheckDTS(genResult.typesDTS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      console.error("Diagnostics:", result.diagnostics);
    }
  });
});
