import { describe, test, expect } from "bun:test";
import { generate, writeGeneratedFiles } from "./generate";
import { NamingStrategy } from "./naming";
import { samResources } from "./sam";
import { fallbackResources } from "./fallback";
import { parseCFNSchema } from "../spec/parse";

describe("generate pipeline components", () => {
  test("exports generate function", () => {
    expect(typeof generate).toBe("function");
  });

  test("exports writeGeneratedFiles function", () => {
    expect(typeof writeGeneratedFiles).toBe("function");
  });

  // Integration test - requires network, skip by default
  test.skip("generates full pipeline (integration)", async () => {
    const result = await generate({ verbose: false });

    expect(result.resources).toBeGreaterThan(500);
    expect(result.properties).toBeGreaterThan(0);
    expect(result.lexiconJSON).toBeTruthy();
    expect(result.typesDTS).toBeTruthy();
    expect(result.indexTS).toBeTruthy();
  });
});

describe("NamingStrategy", () => {
  test("assigns priority names", () => {
    const results = [
      parseCFNSchema(JSON.stringify({ typeName: "AWS::S3::Bucket", properties: {}, additionalProperties: false })),
      parseCFNSchema(JSON.stringify({ typeName: "AWS::Lambda::Function", properties: {}, additionalProperties: false })),
      parseCFNSchema(JSON.stringify({ typeName: "AWS::IAM::Role", properties: {}, additionalProperties: false })),
    ];
    const ns = new NamingStrategy(results);

    expect(ns.resolve("AWS::S3::Bucket")).toBe("Bucket");
    expect(ns.resolve("AWS::Lambda::Function")).toBe("Function");
    expect(ns.resolve("AWS::IAM::Role")).toBe("Role");
  });

  test("handles collisions with service prefix", () => {
    const results = [
      parseCFNSchema(JSON.stringify({ typeName: "AWS::IAM::Policy", properties: {}, additionalProperties: false })),
      parseCFNSchema(JSON.stringify({ typeName: "AWS::S3::BucketPolicy", properties: {}, additionalProperties: false })),
    ];
    const ns = new NamingStrategy(results);

    // IAM Policy has priority name "Policy" and alias "IamPolicy"
    expect(ns.resolve("AWS::IAM::Policy")).toBe("Policy");
    expect(ns.aliases("AWS::IAM::Policy")).toContain("IamPolicy");
  });

  test("handles unknown resources with short names", () => {
    const results = [
      parseCFNSchema(JSON.stringify({ typeName: "AWS::SomeService::SomeResource", properties: {}, additionalProperties: false })),
    ];
    const ns = new NamingStrategy(results);

    expect(ns.resolve("AWS::SomeService::SomeResource")).toBe("SomeResource");
  });
});

describe("SAM resources", () => {
  test("provides 9 SAM resource definitions", () => {
    const resources = samResources();

    expect(resources.length).toBe(9);

    const typeNames = resources.map((r) => r.resource.typeName);
    expect(typeNames).toContain("AWS::Serverless::Function");
    expect(typeNames).toContain("AWS::Serverless::Api");
    expect(typeNames).toContain("AWS::Serverless::HttpApi");
    expect(typeNames).toContain("AWS::Serverless::SimpleTable");
  });
});

describe("fallback resources", () => {
  test("provides LogGroup fallback", () => {
    const resources = fallbackResources();

    expect(resources.length).toBeGreaterThan(0);

    const typeNames = resources.map((r) => r.resource.typeName);
    expect(typeNames).toContain("AWS::Logs::LogGroup");
  });
});

describe("offline fixture pipeline", () => {
  test("generates from fixtures", async () => {
    const { loadSchemaFixtures } = await import("../testdata/load-fixtures");
    const fixtures = loadSchemaFixtures();
    const result = await generate({ schemaSource: fixtures });

    expect(result.resources).toBeGreaterThanOrEqual(5);
    expect(result.lexiconJSON).toBeTruthy();
    expect(result.typesDTS).toBeTruthy();
    expect(result.indexTS).toBeTruthy();

    // Verify known resource types are present in lexicon JSON
    const lexicon = JSON.parse(result.lexiconJSON);
    expect(lexicon["Bucket"]).toBeDefined();
    expect(lexicon["Function"]).toBeDefined();
    expect(lexicon["Role"]).toBeDefined();
  });
});

describe("parseCFNSchema", () => {
  test("parses a minimal schema", () => {
    const result = parseCFNSchema(JSON.stringify({
      typeName: "AWS::Test::Resource",
      properties: {
        Name: { type: "string" },
      },
      required: ["Name"],
      additionalProperties: false,
    }));

    expect(result.resource.typeName).toBe("AWS::Test::Resource");
    expect(result.resource.properties.length).toBe(1);
    expect(result.resource.properties[0].name).toBe("Name");
    expect(result.resource.properties[0].required).toBe(true);
  });
});
