import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { nameFountainSchemas, parseFountainOpenAPI, schemaToClassName } from "./parse";
import { NamingStrategy, publishedNames, publishedSchemaNames } from "../codegen/naming";

const snapshot = readFileSync(join(import.meta.dirname, "fountain-openapi.snapshot.json"), "utf-8");

/**
 * The pinned spec, plus an upstream `repository` schema that AgentRequest
 * reaches. It maps to the same class name as the published `Repository`.
 */
function withNewcomer(): string {
  const spec = JSON.parse(snapshot);
  const schemas = spec.components.schemas;
  schemas.repository = { type: "object", properties: { url: { type: "string" }, ref: { type: "string" } } };
  schemas.AgentRequest.properties.repo = { $ref: "#/components/schemas/repository" };
  return JSON.stringify(spec);
}

const propertyTypes = (results: ReturnType<typeof parseFountainOpenAPI>) =>
  Object.fromEntries(results.filter((r) => r.isProperty).map((r) => [r.schema, r.resource.typeName]));

describe("published fountain names stay with their schemas (#5569)", () => {
  test("the committed snapshot records the schema behind each published property type", () => {
    expect(publishedSchemaNames()).toEqual({ Repository: "Repository" });
    expect(publishedNames()["Fountain::V1::Repository"]).toBe("Repository");
    expect(publishedSchemaNames(join(import.meta.dirname, "no-such-dir", "surface.snapshot.json"))).toEqual({});
  });

  test("a newcomer sharing the published Repository is qualified and Repository stays", () => {
    const results = parseFountainOpenAPI(withNewcomer(), publishedSchemaNames());
    expect(propertyTypes(results)).toMatchObject({
      Repository: "Fountain::V1::Repository",
      repository: "Fountain::V1::V1Repository",
    });
    expect(new Set(results.map((r) => r.resource.typeName)).size).toBe(results.length);

    const agent = results.find((r) => r.resource.typeName === "Fountain::V1::Agent")!;
    expect(agent.resource.properties.find((p) => p.name === "repo")?.tsType).toBe("V1Repository");
    const environment = results.find((r) => r.resource.typeName === "Fountain::V1::Environment")!;
    expect(environment.resource.properties.find((p) => p.name === "repositories")?.tsType).toBe("Repository[]");

    const naming = new NamingStrategy(results, publishedNames());
    expect(naming.resolve("Fountain::V1::Repository")).toBe("Repository");
    expect(naming.resolve("Fountain::V1::V1Repository")).toBe("V1Repository");
  });

  test("the published name stays whichever schema the spec lists first", () => {
    const names = nameFountainSchemas(["repository", "Repository"], { Repository: "Repository" });
    expect(Object.fromEntries(names)).toEqual({ repository: "V1Repository", Repository: "Repository" });
  });

  test("a schema that would take a resource's name is qualified", () => {
    expect(Object.fromEntries(nameFountainSchemas(["agent"]))).toEqual({ agent: "V1Agent" });
  });

  test("without published names, two schemas left with one name are refused", () => {
    expect(() => nameFountainSchemas(["Repository", "repository"])).toThrow(
      /schema repository would take the type name V1Repository, which schema Repository holds/,
    );
  });

  test("schemaToClassName leads with the service segment only when asked", () => {
    expect(schemaToClassName("repository")).toBe("Repository");
    expect(schemaToClassName("repository", true)).toBe("V1Repository");
  });
});
