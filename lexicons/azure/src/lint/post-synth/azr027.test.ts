import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr027 } from "./azr027";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR027: Container Registry Admin Enabled", () => {
  test("check metadata", () => {
    expect(azr027.id).toBe("AZR027");
    expect(azr027.description).toBeTruthy();
  });

  test("warns when admin user is enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerRegistry/registries",
          apiVersion: "2023-07-01",
          name: "myAcr",
          location: "[resourceGroup().location]",
          properties: { adminUserEnabled: true },
        },
      ],
    });

    const diags = azr027.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR027");
    expect(diags[0].message).toContain("admin user");
  });

  test("no diagnostic when admin user is disabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerRegistry/registries",
          apiVersion: "2023-07-01",
          name: "myAcr",
          location: "[resourceGroup().location]",
          properties: { adminUserEnabled: false },
        },
      ],
    });

    const diags = azr027.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
