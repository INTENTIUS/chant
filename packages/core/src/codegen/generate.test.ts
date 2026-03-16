import { describe, test, expect } from "bun:test";
import { generatePipeline, type GeneratePipelineConfig, type ParsedResult } from "./generate";
import { NamingStrategy } from "./naming";

interface TestResult extends ParsedResult {
  name: string;
}

function makeConfig(
  schemas: Map<string, Buffer>,
  parseOverride?: (name: string, data: Buffer) => TestResult | TestResult[] | null,
): GeneratePipelineConfig<TestResult> {
  return {
    fetchSchemas: async () => schemas,
    parseSchema: parseOverride ?? ((name, _data) => ({
      name,
      propertyTypes: [],
      enums: [],
    })),
    createNaming: (results) => new NamingStrategy(
      results.map((r) => ({ typeName: r.name, propertyTypes: r.propertyTypes })),
      {
        priorityNames: {},
        priorityAliases: {},
        priorityPropertyAliases: {},
        serviceAbbreviations: {},
        shortName: (t) => t,
        serviceName: () => "",
      },
    ),
    generateRegistry: () => "{}",
    generateTypes: () => "// types",
    generateRuntimeIndex: () => "// index",
  };
}

describe("generatePipeline", () => {
  test("processes single-result parseSchema", async () => {
    const schemas = new Map([
      ["TypeA", Buffer.from("a")],
      ["TypeB", Buffer.from("b")],
    ]);
    const result = await generatePipeline(makeConfig(schemas));
    expect(result.resources).toBe(2);
    expect(result.warnings).toHaveLength(0);
  });

  test("supports parseSchema returning arrays", async () => {
    const schemas = new Map([
      ["combined", Buffer.from("data")],
    ]);

    const config = makeConfig(schemas, (_name, _data) => [
      { name: "TypeA", propertyTypes: [{ name: "PropA" }], enums: [] },
      { name: "TypeB", propertyTypes: [{ name: "PropB" }], enums: [] },
      { name: "TypeC", propertyTypes: [], enums: [{}] },
    ]);

    const result = await generatePipeline(config);
    expect(result.resources).toBe(3);
    expect(result.properties).toBe(2);
    expect(result.enums).toBe(1);
  });

  test("handles parseSchema returning null (skip)", async () => {
    const schemas = new Map([
      ["skip-me", Buffer.from("x")],
      ["keep-me", Buffer.from("y")],
    ]);
    const config = makeConfig(schemas, (name, _data) => {
      if (name === "skip-me") return null;
      return { name, propertyTypes: [], enums: [] };
    });

    const result = await generatePipeline(config);
    expect(result.resources).toBe(1);
  });

  test("handles mixed single and array returns", async () => {
    const schemas = new Map([
      ["single", Buffer.from("s")],
      ["multi", Buffer.from("m")],
    ]);
    const config = makeConfig(schemas, (name, _data) => {
      if (name === "multi") {
        return [
          { name: "MultiA", propertyTypes: [], enums: [] },
          { name: "MultiB", propertyTypes: [], enums: [] },
        ];
      }
      return { name, propertyTypes: [], enums: [] };
    });

    const result = await generatePipeline(config);
    expect(result.resources).toBe(3);
  });

  test("collects parse errors as warnings", async () => {
    const schemas = new Map([
      ["bad", Buffer.from("x")],
    ]);
    const config = makeConfig(schemas, () => {
      throw new Error("parse failed");
    });

    const result = await generatePipeline(config);
    expect(result.resources).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].error).toContain("parse failed");
  });
});
