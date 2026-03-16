import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr014 } from "./azr014";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR014: Public Blob Access Enabled", () => {
  test("check metadata", () => {
    expect(azr014.id).toBe("AZR014");
    expect(azr014.description).toBeTruthy();
  });

  test("warns when allowBlobPublicAccess is true", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: { allowBlobPublicAccess: true },
        },
      ],
    });

    const diags = azr014.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR014");
    expect(diags[0].message).toContain("allowBlobPublicAccess");
  });

  test("warns when allowBlobPublicAccess is not set", () => {
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

    const diags = azr014.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("no diagnostic when allowBlobPublicAccess is false", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: { allowBlobPublicAccess: false },
        },
      ],
    });

    const diags = azr014.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
