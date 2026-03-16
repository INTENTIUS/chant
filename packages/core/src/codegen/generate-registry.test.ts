import { describe, expect, test } from "bun:test";
import { buildRegistry, serializeRegistry, type RegistryResource, type RegistryConfig } from "./generate-registry";
import { NamingStrategy, type NamingInput, type NamingConfig } from "./naming";

interface TestEntry {
  resourceType: string;
  kind: "resource" | "property";
  attrs?: Record<string, string>;
}

function makeNaming(results: RegistryResource[]): NamingStrategy {
  const inputs: NamingInput[] = results.map((r) => ({
    typeName: r.typeName,
    propertyTypes: r.propertyTypes,
  }));
  const config: NamingConfig = {
    priorityNames: {},
    priorityAliases: {},
    priorityPropertyAliases: {},
    serviceAbbreviations: {},
    shortName: (t) => t.split("::")[2] ?? t,
    serviceName: (t) => t.split("::")[1] ?? t,
  };
  return new NamingStrategy(inputs, config);
}

const testConfig: RegistryConfig<TestEntry> = {
  shortName: (t) => t.split("::")[2] ?? t,
  buildEntry: (_resource, _tsName, attrs) => ({
    resourceType: _resource.typeName,
    kind: "resource",
    ...(attrs && { attrs }),
  }),
  buildPropertyEntry: (resourceType, propertyType) => ({
    resourceType: `${resourceType}.${propertyType}`,
    kind: "property",
  }),
};

describe("buildRegistry", () => {
  test("builds entries with attrs map", () => {
    const resources: RegistryResource[] = [
      {
        typeName: "Test::S3::Bucket",
        attributes: [{ name: "Arn" }, { name: "DomainName" }],
        properties: [],
        propertyTypes: [],
      },
    ];
    const naming = makeNaming(resources);
    const entries = buildRegistry(resources, naming, testConfig);

    expect(entries["Bucket"]).toBeDefined();
    expect(entries["Bucket"].attrs).toEqual({ Arn: "Arn", DomainName: "DomainName" });
  });

  test("omits attrs when empty", () => {
    const resources: RegistryResource[] = [
      { typeName: "Test::S3::Bucket", attributes: [], properties: [], propertyTypes: [] },
    ];
    const naming = makeNaming(resources);
    const entries = buildRegistry(resources, naming, testConfig);
    expect(entries["Bucket"].attrs).toBeUndefined();
  });

  test("includes property type entries", () => {
    const resources: RegistryResource[] = [
      {
        typeName: "Test::S3::Bucket",
        attributes: [],
        properties: [],
        propertyTypes: [{ name: "Bucket_Versioning", specType: "Versioning" }],
      },
    ];
    const naming = makeNaming(resources);
    const entries = buildRegistry(resources, naming, testConfig);
    expect(entries["Bucket_Versioning"]).toEqual({
      resourceType: "Test::S3::Bucket.Versioning",
      kind: "property",
    });
  });

  test("filters empty constraints", () => {
    const resources: RegistryResource[] = [
      {
        typeName: "Test::S3::Bucket",
        attributes: [],
        properties: [
          { name: "Name", constraints: { minLength: 3 } },
          { name: "Tag", constraints: {} },
        ],
        propertyTypes: [],
      },
    ];
    const naming = makeNaming(resources);

    let capturedConstraints: Record<string, unknown> | undefined;
    const config: RegistryConfig<TestEntry> = {
      ...testConfig,
      buildEntry: (_r, _t, _a, propConstraints) => {
        capturedConstraints = propConstraints;
        return { resourceType: _r.typeName, kind: "resource" };
      },
    };

    buildRegistry(resources, naming, config);
    expect(capturedConstraints).toEqual({ Name: { minLength: 3 } });
  });
});

describe("serializeRegistry", () => {
  test("sorts keys deterministically", () => {
    const entries = { Zebra: { a: 1 }, Apple: { b: 2 }, Mango: { c: 3 } };
    const json = serializeRegistry(entries);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed)).toEqual(["Apple", "Mango", "Zebra"]);
  });
});
