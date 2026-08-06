import { describe, test, expect } from "vitest";
import { generate, writeGeneratedFiles } from "./generate";
import { parseConfigSchema } from "./parse";
import { loadSchemaFixture, loadSchemaFixtureMap } from "../testdata/load-fixtures";

const PROPERTY_ENTITY_NAMES = [
  "Metadata",
  "KubeAPI",
  "Volume",
  "Port",
  "File",
  "EnvVar",
  "HostAlias",
  "Registries",
  "RegistryCreate",
  "RegistryProxy",
  "Options",
  "K3dOptions",
  "LoadbalancerOptions",
  "K3sOptions",
  "K3sExtraArg",
  "NodeLabel",
  "KubeconfigOptions",
  "RuntimeOptions",
  "RuntimeLabel",
  "Ulimit",
];

describe("generate pipeline", () => {
  test("generate function is exported and callable", () => {
    expect(typeof generate).toBe("function");
  });

  test("writeGeneratedFiles function is exported", () => {
    expect(typeof writeGeneratedFiles).toBe("function");
  });
});

describe("offline fixture pipeline", () => {
  test("registry parses and covers all entities", async () => {
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });

    expect(result.resources).toBe(21);
    expect(result.warnings).toHaveLength(0);

    const lexicon = JSON.parse(result.lexiconJSON);
    expect(Object.keys(lexicon)).toHaveLength(21);
  });

  test("K3d::Cluster is present with kind resource", async () => {
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });
    const lexicon = JSON.parse(result.lexiconJSON);

    expect(lexicon["Cluster"]).toBeDefined();
    expect(lexicon["Cluster"].resourceType).toBe("K3d::Cluster");
    expect(lexicon["Cluster"].kind).toBe("resource");
    expect(lexicon["Cluster"].lexicon).toBe("k3d");
  });

  test("apiVersion and kind survive as declared Cluster properties", async () => {
    // The serializer needs these to round-trip into the emitted config;
    // they must not be stripped by codegen.
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });

    expect(result.typesDTS).toContain('apiVersion: "k3d.io/v1alpha5";');
    expect(result.typesDTS).toContain('kind: "Simple";');

    const lexicon = JSON.parse(result.lexiconJSON);
    expect(lexicon["Cluster"].constraints.apiVersion.enum).toEqual(["k3d.io/v1alpha5"]);
    expect(lexicon["Cluster"].constraints.kind.enum).toEqual(["Simple"]);
  });

  test("all property entities are present with kind property", async () => {
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });
    const lexicon = JSON.parse(result.lexiconJSON);

    for (const name of PROPERTY_ENTITY_NAMES) {
      expect(lexicon[name], name).toBeDefined();
      expect(lexicon[name].kind, name).toBe("property");
      expect(lexicon[name].resourceType, name).toBe(`K3d::${name}`);
    }
  });

  test("the misplaced additionalProperties key is not emitted anywhere", async () => {
    // Upstream bug: registries.properties contains a nested
    // "additionalProperties": false — a naive walk would emit a property
    // literally named additionalProperties. See parse.ts.
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });

    expect(result.typesDTS).not.toContain("additionalProperties");
    expect(result.lexiconJSON).not.toContain("additionalProperties");
    expect(result.indexTS).not.toContain("additionalProperties");
  });

  test("type-less timeout with string examples is typed as string", async () => {
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });
    expect(result.typesDTS).toContain("timeout?: string;");
  });

  test("Cluster cross-references property entity classes", async () => {
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });

    expect(result.typesDTS).toContain("volumes?: Volume[];");
    expect(result.typesDTS).toContain("ports?: Port[];");
    expect(result.typesDTS).toContain("files?: File[];");
    expect(result.typesDTS).toContain("env?: EnvVar[];");
    expect(result.typesDTS).toContain("hostAliases?: HostAlias[];");
    expect(result.typesDTS).toContain("registries?: Registries;");
    expect(result.typesDTS).toContain("options?: Options;");
    expect(result.typesDTS).toContain("kubeAPI?: KubeAPI;");
    expect(result.typesDTS).toContain("metadata?: Metadata;");
    // Nested cross-references
    expect(result.typesDTS).toContain("k3d?: K3dOptions;");
    expect(result.typesDTS).toContain("extraArgs?: K3sExtraArg[];");
    expect(result.typesDTS).toContain("proxy?: RegistryProxy;");
  });

  test("KubeconfigOptions has its boolean flags", async () => {
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });
    expect(result.typesDTS).toContain("updateDefaultKubeconfig?: boolean;");
    expect(result.typesDTS).toContain("switchCurrentContext?: boolean;");
  });

  test("nodeFilters resolves through the definition to string[]", async () => {
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });
    expect(result.typesDTS).toContain("nodeFilters?: string[];");
  });

  test("runtime index exports Cluster as resource and the rest as properties", async () => {
    const result = await generate({ schemaSource: loadSchemaFixtureMap() });

    expect(result.indexTS).toContain('export const Cluster = createResource("K3d::Cluster", "k3d", {});');
    for (const name of PROPERTY_ENTITY_NAMES) {
      expect(result.indexTS).toContain(`export const ${name} = createProperty("K3d::${name}", "k3d");`);
    }
  });
});

describe("parseConfigSchema", () => {
  test("splits the single schema into 21 entities", () => {
    const results = parseConfigSchema(loadSchemaFixture());
    expect(results).toHaveLength(21);
    expect(results[0].resource.typeName).toBe("K3d::Cluster");
    expect(results[0].isProperty).toBeUndefined();
    expect(results.filter((r) => r.isProperty)).toHaveLength(20);
  });

  test("files item keeps its required properties", () => {
    const results = parseConfigSchema(loadSchemaFixture());
    const file = results.find((r) => r.resource.typeName === "K3d::File");
    const required = file!.resource.properties.filter((p) => p.required).map((p) => p.name);
    expect(required.sort()).toEqual(["destination", "source"]);
  });
});
