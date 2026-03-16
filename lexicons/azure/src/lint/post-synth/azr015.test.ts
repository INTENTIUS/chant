import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr015 } from "./azr015";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR015: Missing Encryption", () => {
  test("check metadata", () => {
    expect(azr015.id).toBe("AZR015");
    expect(azr015.description).toBeTruthy();
  });

  test("warns when no encryption configured", () => {
    const ctx = makeCtx({
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
      ],
    });

    const diags = azr015.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR015");
    expect(diags[0].message).toContain("no encryption");
  });

  test("warns when encryption services missing blob", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: {
            encryption: {
              services: { file: { enabled: true } },
            },
          },
        },
      ],
    });

    const diags = azr015.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("blob");
  });

  test("no diagnostic with full encryption", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: {
            encryption: {
              services: {
                blob: { enabled: true },
                file: { enabled: true },
              },
            },
          },
        },
      ],
    });

    const diags = azr015.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
