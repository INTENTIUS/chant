/**
 * End-to-end round-trip tests — parse → generate → verify.
 *
 * Parser and generator unit tests are in parser.test.ts and generator.test.ts.
 */

import { describe, it, expect } from "vitest";
import { ArmParser } from "./parser";
import { ArmGenerator } from "./generator";

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const testdataDir = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "testdata", "quickstarts");

describe("ARM Import Round-trip", () => {
  const parser = new ArmParser();
  const generator = new ArmGenerator();

  it("round-trips a simple storage template", () => {
    const template = {
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

    const ir = parser.parse(JSON.stringify(template));
    const files = generator.generate(ir);

    expect(files.length).toBeGreaterThanOrEqual(1);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile).toBeDefined();
    // The generated output includes Azure pseudo-parameter references
    expect(mainFile!.content).toContain("Azure");
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

  it("round-trips a template with no parameters", () => {
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

    const files = generator.generate(ir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile!.content).toContain("fixedName");
    expect(mainFile!.content).toContain("StorageV2");
  });
});

// --- File-based round-trip tests for testdata fixtures ---

describe("ARM Import Round-trip — testdata fixtures", () => {
  const parser = new ArmParser();
  const generator = new ArmGenerator();

  const fixtures = [
    { file: "vnet-nsg.json", expectedResources: 3, contains: "VirtualNetwork" },
    { file: "aks-basic.json", expectedResources: 1, contains: "ManagedCluster" },
    { file: "function-app.json", expectedResources: 3, contains: "WebApp" },
    { file: "keyvault-secrets.json", expectedResources: 2, contains: "Microsoft.KeyVault/vaults" },
    { file: "sql-server-db.json", expectedResources: 5, contains: "Microsoft.Sql/servers" },
    { file: "cosmos-account.json", expectedResources: 3, contains: "Microsoft.DocumentDB/databaseAccounts" },
    { file: "container-instance.json", expectedResources: 1, contains: "containerGroups" },
    { file: "app-gateway.json", expectedResources: 3, contains: "applicationGateways" },
  ];

  for (const { file, expectedResources, contains } of fixtures) {
    it(`round-trips ${file}`, () => {
      const content = readFileSync(join(testdataDir, file), "utf-8");
      const ir = parser.parse(content);

      expect(ir.resources).toHaveLength(expectedResources);

      const files = generator.generate(ir);
      expect(files.length).toBeGreaterThanOrEqual(1);

      const mainFile = files.find((f) => f.path === "main.ts");
      expect(mainFile).toBeDefined();
      expect(mainFile!.content).toContain(contains);
    });
  }
});
