import { describe, test, expect } from "bun:test";
import { generate } from "./generate";
import { loadSchemaFixtures } from "../testdata/load-fixtures";

describe("generation idempotency", () => {
  test("two generations from same fixtures produce identical content", async () => {
    const fixtures = loadSchemaFixtures();

    const result1 = await generate({ schemaSource: fixtures });
    const result2 = await generate({ schemaSource: fixtures });

    // Content should be byte-identical
    expect(result1.lexiconJSON).toBe(result2.lexiconJSON);
    expect(result1.typesDTS).toBe(result2.typesDTS);
    expect(result1.indexTS).toBe(result2.indexTS);
  });

  test("resource counts match between runs", async () => {
    const fixtures = loadSchemaFixtures();

    const result1 = await generate({ schemaSource: fixtures });
    const result2 = await generate({ schemaSource: fixtures });

    expect(result1.resources).toBe(result2.resources);
    expect(result1.properties).toBe(result2.properties);
    expect(result1.enums).toBe(result2.enums);
  });
});
