import { describe, it, expect } from "bun:test";
import { ArmParser } from "./parser";
import { ArmGenerator } from "./generator";

const simpleStorageTemplate = {
  $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    storageAccountName: {
      type: "string",
      metadata: { description: "Name of the storage account" },
    },
  },
  resources: [
    {
      type: "Microsoft.Storage/storageAccounts",
      apiVersion: "2023-05-01",
      name: "[parameters('storageAccountName')]",
      location: "[resourceGroup().location]",
      kind: "StorageV2",
      sku: { name: "Standard_LRS" },
      properties: {
        supportsHttpsTrafficOnly: true,
        minimumTlsVersion: "TLS1_2",
      },
    },
  ],
};

describe("ARM Import Round-trip", () => {
  const parser = new ArmParser();
  const generator = new ArmGenerator();

  it("parses a simple ARM template to IR", () => {
    const ir = parser.parse(JSON.stringify(simpleStorageTemplate));

    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].type).toBe("Microsoft.Storage/storageAccounts");
    expect(ir.parameters).toHaveLength(1);
    expect(ir.parameters[0].name).toBe("storageAccountName");
    expect(ir.metadata?.format).toBe("arm");
  });

  it("parses resource-level fields into properties", () => {
    const ir = parser.parse(JSON.stringify(simpleStorageTemplate));
    const resource = ir.resources[0];

    // sku and kind are resource-level fields parsed into properties
    expect(resource.properties.sku).toEqual({ name: "Standard_LRS" });
    expect(resource.properties.kind).toBe("StorageV2");
  });

  it("parses bracket expressions to intrinsic markers", () => {
    const ir = parser.parse(JSON.stringify(simpleStorageTemplate));
    const resource = ir.resources[0];

    // [resourceGroup().location] → intrinsic marker
    expect(resource.properties.location).toEqual({
      __intrinsic: "ResourceGroup",
      property: "location",
    });
  });

  it("parses parameters bracket expression", () => {
    const ir = parser.parse(JSON.stringify(simpleStorageTemplate));
    const resource = ir.resources[0];

    // [parameters('storageAccountName')] → intrinsic Ref marker
    expect(resource.logicalId).toEqual({
      __intrinsic: "Ref",
      name: "storageAccountName",
    });
  });

  it("generates TypeScript from IR", () => {
    const ir = parser.parse(JSON.stringify(simpleStorageTemplate));
    const files = generator.generate(ir);

    expect(files.length).toBeGreaterThanOrEqual(1);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile).toBeDefined();
    expect(mainFile!.content).toContain("@intentius/chant-lexicon-azure");
  });

  it("round-trips a multi-resource template through parse → generate", () => {
    const multiTemplate = {
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          sku: { name: "Standard_LRS" },
          kind: "StorageV2",
          properties: {
            supportsHttpsTrafficOnly: true,
          },
        },
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2023-01-01",
          name: "myWebApp",
          location: "[resourceGroup().location]",
          properties: {
            httpsOnly: true,
          },
          dependsOn: [
            "[resourceId('Microsoft.Storage/storageAccounts', 'myStorage')]",
          ],
        },
      ],
    };

    const ir = parser.parse(JSON.stringify(multiTemplate));

    expect(ir.resources).toHaveLength(2);
    expect(ir.resources[0].type).toBe("Microsoft.Storage/storageAccounts");
    expect(ir.resources[1].type).toBe("Microsoft.Web/sites");

    // dependsOn should be parsed
    expect(ir.resources[1].dependsOn).toBeDefined();
    expect(ir.resources[1].dependsOn!.length).toBeGreaterThan(0);

    const files = generator.generate(ir);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("handles templates with no parameters", () => {
    const noParamsTemplate = {
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "fixedName",
          location: "eastus",
          sku: { name: "Standard_LRS" },
          kind: "StorageV2",
          properties: {},
        },
      ],
    };

    const ir = parser.parse(JSON.stringify(noParamsTemplate));
    expect(ir.parameters).toHaveLength(0);
    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].logicalId).toBe("fixedName");
  });

  it("rejects invalid ARM templates", () => {
    expect(() => parser.parse("{}")).toThrow("missing resources array");
    expect(() => parser.parse("not json")).toThrow();
  });
});
