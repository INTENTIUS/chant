import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr021 } from "./azr021";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR021: App Service Missing HTTPS-Only", () => {
  test("check metadata", () => {
    expect(azr021.id).toBe("AZR021");
    expect(azr021.description).toBeTruthy();
  });

  test("warns when httpsOnly is not true", () => {
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

    const diags = azr021.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR021");
    expect(diags[0].message).toContain("HTTPS-only");
  });

  test("no diagnostic when httpsOnly is true", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2022-09-01",
          name: "myApp",
          location: "[resourceGroup().location]",
          properties: { httpsOnly: true },
        },
      ],
    });

    const diags = azr021.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
