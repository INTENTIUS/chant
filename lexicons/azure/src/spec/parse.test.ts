import { describe, it, expect } from "vitest";
import { parseArmSchema, armShortName, armServiceName } from "./parse";

describe("armShortName", () => {
  it("extracts short name from resource type", () => {
    expect(armShortName("Microsoft.Storage/storageAccounts")).toBe("storageAccounts");
    expect(armShortName("Microsoft.Compute/virtualMachines")).toBe("virtualMachines");
  });
});

describe("armServiceName", () => {
  it("extracts service name from resource type", () => {
    expect(armServiceName("Microsoft.Storage/storageAccounts")).toBe("Storage");
    expect(armServiceName("Microsoft.Compute/virtualMachines")).toBe("Compute");
    expect(armServiceName("Microsoft.ContainerService/managedClusters")).toBe("ContainerService");
  });
});

describe("parseArmSchema", () => {
  it("parses a simple resource schema", () => {
    const schema = {
      resourceType: "Microsoft.Storage/storageAccounts",
      apiVersion: "2023-01-01",
      provider: "Microsoft.Storage",
      resourceName: "storageAccounts",
      resourceDefinition: {
        properties: {
          name: { type: "string", description: "Storage account name" },
          type: { type: "string" },
          apiVersion: { type: "string" },
          location: { type: "string" },
          tags: { type: "object" },
          properties: {
            type: "object",
            properties: {
              supportsHttpsTrafficOnly: { type: "boolean" },
              minimumTlsVersion: { type: "string", enum: ["TLS1_0", "TLS1_1", "TLS1_2"] },
            },
          },
        },
        required: ["name", "location"],
      },
      definitions: {},
    };

    const result = parseArmSchema(JSON.stringify(schema));

    expect(result.resource.typeName).toBe("Microsoft.Storage/storageAccounts");
    expect(result.resource.apiVersion).toBe("2023-01-01");
    expect(result.resource.properties.length).toBeGreaterThan(0);
    expect(result.resource.resourceLevelFields).toContain("location");
    expect(result.resource.resourceLevelFields).toContain("tags");
    expect(result.resource.tagging?.taggable).toBe(true);
  });

  it("extracts curated attributes", () => {
    const schema = {
      resourceType: "Microsoft.Storage/storageAccounts",
      apiVersion: "2023-01-01",
      provider: "Microsoft.Storage",
      resourceName: "storageAccounts",
      resourceDefinition: { properties: {} },
      definitions: {},
    };

    const result = parseArmSchema(JSON.stringify(schema));
    expect(result.resource.attributes.length).toBeGreaterThan(0);
    expect(result.resource.attributes.find((a) => a.name === "id")).toBeTruthy();
  });

  it("parses definitions into property types and enums", () => {
    const schema = {
      resourceType: "Microsoft.Test/resources",
      apiVersion: "2023-01-01",
      provider: "Microsoft.Test",
      resourceName: "resources",
      resourceDefinition: { properties: {} },
      definitions: {
        Sku: {
          type: "object",
          properties: {
            name: { type: "string" },
            tier: { type: "string" },
          },
          required: ["name"],
        },
        SkuName: {
          type: "string",
          enum: ["Basic", "Standard", "Premium"],
        },
      },
    };

    const result = parseArmSchema(JSON.stringify(schema));
    expect(result.propertyTypes.length).toBe(1);
    expect(result.propertyTypes[0].name).toBe("resources_Sku");
    expect(result.enums.length).toBe(1);
    expect(result.enums[0].values).toEqual(["Basic", "Standard", "Premium"]);
  });
});
