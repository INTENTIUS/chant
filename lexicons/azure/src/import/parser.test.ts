import { describe, it, expect } from "bun:test";
import { ArmParser } from "./parser";

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

describe("ArmParser", () => {
  const parser = new ArmParser();

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

  it("preserves parameters bracket expression in logicalId", () => {
    const ir = parser.parse(JSON.stringify(simpleStorageTemplate));
    const resource = ir.resources[0];

    // logicalId stores the raw name (bracket expression)
    expect(resource.logicalId).toBe("[parameters('storageAccountName')]");
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

  it("parses dependsOn with resourceId expressions", () => {
    const template = {
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: {},
        },
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2023-01-01",
          name: "myWebApp",
          location: "[resourceGroup().location]",
          dependsOn: [
            "[resourceId('Microsoft.Storage/storageAccounts', 'myStorage')]",
          ],
          properties: {},
        },
      ],
    };

    const ir = parser.parse(JSON.stringify(template));
    expect(ir.resources).toHaveLength(2);
    expect(ir.resources[1].dependsOn).toBeDefined();
    expect(ir.resources[1].dependsOn!.length).toBeGreaterThan(0);
  });

  it("parses subscription bracket expression", () => {
    const template = {
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: {
            subId: "[subscription().subscriptionId]",
          },
        },
      ],
    };

    const ir = parser.parse(JSON.stringify(template));
    expect(ir.resources[0].properties.subId).toEqual({
      __intrinsic: "Subscription",
      property: "subscriptionId",
    });
  });

  it("parses parameter types correctly", () => {
    const template = {
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      parameters: {
        myString: { type: "string" },
        myInt: { type: "int" },
        myBool: { type: "bool" },
      },
      resources: [],
    };

    const ir = parser.parse(JSON.stringify(template));
    expect(ir.parameters).toHaveLength(3);
    expect(ir.parameters[0].type).toBe("String");
    expect(ir.parameters[1].type).toBe("Number");
  });

  it("preserves metadata schema and content version", () => {
    const ir = parser.parse(JSON.stringify(simpleStorageTemplate));
    expect(ir.metadata?.schema).toBe(simpleStorageTemplate.$schema);
    expect(ir.metadata?.contentVersion).toBe("1.0.0.0");
  });
});
