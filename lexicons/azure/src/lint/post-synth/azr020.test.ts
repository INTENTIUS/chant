import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr020 } from "./azr020";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR020: App Service Missing Managed Identity", () => {
  test("check metadata", () => {
    expect(azr020.id).toBe("AZR020");
    expect(azr020.description).toBeTruthy();
  });

  test("warns when no identity configured", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2022-09-01",
          name: "myApp",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr020.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR020");
    expect(diags[0].message).toContain("managed identity");
  });

  test("no diagnostic when SystemAssigned identity exists", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2022-09-01",
          name: "myApp",
          location: "[resourceGroup().location]",
          identity: { type: "SystemAssigned" },
          properties: {},
        },
      ],
    });

    const diags = azr020.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
