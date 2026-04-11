import { describe, test, expect } from "vitest";
import { generate, writeGeneratedFiles } from "./generate";
import { loadSchemaFixtureMap } from "../testdata/load-fixtures";

describe("generate pipeline components", () => {
  test("exports generate function", () => {
    expect(typeof generate).toBe("function");
  });

  test("exports writeGeneratedFiles function", () => {
    expect(typeof writeGeneratedFiles).toBe("function");
  });

  // Integration test — requires network, skip by default
  test.skip("generates full pipeline (integration)", async () => {
    const result = await generate({ verbose: false });

    expect(result.resources).toBeGreaterThan(0);
    expect(result.properties).toBeGreaterThan(0);
    expect(result.lexiconJSON).toBeTruthy();
    expect(result.typesDTS).toBeTruthy();
    expect(result.indexTS).toBeTruthy();
  });
});

describe("offline fixture pipeline", () => {
  test("generates from fixtures", async () => {
    const fixtures = loadSchemaFixtureMap();
    const result = await generate({ schemaSource: fixtures });

    expect(result.resources).toBeGreaterThanOrEqual(1);
    expect(result.properties).toBeGreaterThanOrEqual(0);
    expect(result.lexiconJSON).toBeTruthy();
    expect(result.typesDTS).toBeTruthy();
    expect(result.indexTS).toBeTruthy();
  });

  test("output contains expected entities", async () => {
    const fixtures = loadSchemaFixtureMap();
    const result = await generate({ schemaSource: fixtures });

    const lexicon = JSON.parse(result.lexiconJSON);
    // Core CI entities should be present
    expect(lexicon["Job"]).toBeDefined();
    expect(lexicon["Default"]).toBeDefined();
    expect(lexicon["Workflow"]).toBeDefined();
  });

  test("resource and property counts are non-zero", async () => {
    const fixtures = loadSchemaFixtureMap();
    const result = await generate({ schemaSource: fixtures });

    expect(result.resources).toBeGreaterThan(0);
    // Properties are optional in a minimal fixture but count should be defined
    expect(typeof result.properties).toBe("number");
    expect(typeof result.enums).toBe("number");
  });

  test("produces no warnings from fixtures", async () => {
    const fixtures = loadSchemaFixtureMap();
    const result = await generate({ schemaSource: fixtures });

    expect(result.warnings).toHaveLength(0);
  });
});
