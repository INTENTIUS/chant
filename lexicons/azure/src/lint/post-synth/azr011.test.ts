import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr011 } from "./azr011";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR011: Missing or Invalid API Version", () => {
  test("check metadata", () => {
    expect(azr011.id).toBe("AZR011");
    expect(azr011.description).toBeTruthy();
  });

  test("emits error for missing apiVersion", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          name: "myStorage",
          location: "[resourceGroup().location]",
        },
      ],
    });

    const diags = azr011.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR011");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("missing apiVersion");
  });

  test("emits error for invalid apiVersion format", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "v1",
          name: "myStorage",
          location: "[resourceGroup().location]",
        },
      ],
    });

    const diags = azr011.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("invalid apiVersion");
  });

  test("no diagnostic for valid apiVersion", () => {
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

    const diags = azr011.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("allows preview apiVersion", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2024-01-01-preview",
          name: "myStorage",
          location: "[resourceGroup().location]",
        },
      ],
    });

    const diags = azr011.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
