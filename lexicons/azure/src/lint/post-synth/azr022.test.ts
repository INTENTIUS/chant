import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr022 } from "./azr022";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR022: App Service Missing Minimum TLS 1.2", () => {
  test("check metadata", () => {
    expect(azr022.id).toBe("AZR022");
    expect(azr022.description).toBeTruthy();
  });

  test("warns when minTlsVersion is not set", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2022-09-01",
          name: "myApp",
          location: "[resourceGroup().location]",
          properties: { siteConfig: {} },
        },
      ],
    });

    const diags = azr022.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR022");
    expect(diags[0].message).toContain("TLS 1.2");
  });

  test("no diagnostic when minTlsVersion is 1.2", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2022-09-01",
          name: "myApp",
          location: "[resourceGroup().location]",
          properties: { siteConfig: { minTlsVersion: "1.2" } },
        },
      ],
    });

    const diags = azr022.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
