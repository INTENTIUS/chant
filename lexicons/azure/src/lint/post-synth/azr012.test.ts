import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr012 } from "./azr012";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR012: Deprecated API Version", () => {
  test("check metadata", () => {
    expect(azr012.id).toBe("AZR012");
    expect(azr012.description).toBeTruthy();
  });

  test("warns for old apiVersion", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2021-04-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
        },
      ],
    });

    const diags = azr012.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR012");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("outdated apiVersion");
  });

  test("no diagnostic for recent apiVersion", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
        },
      ],
    });

    const diags = azr012.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
