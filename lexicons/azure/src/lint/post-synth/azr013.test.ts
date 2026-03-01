import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr013 } from "./azr013";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR013: Resource Missing Location", () => {
  test("check metadata", () => {
    expect(azr013.id).toBe("AZR013");
    expect(azr013.description).toBeTruthy();
  });

  test("warns for resource missing location", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
        },
      ],
    });

    const diags = azr013.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR013");
    expect(diags[0].message).toContain("missing a location");
  });

  test("no diagnostic when location is present", () => {
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

    const diags = azr013.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("skips exempt resource types", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Authorization/roleAssignments",
          apiVersion: "2023-05-01",
          name: "myAssignment",
        },
      ],
    });

    const diags = azr013.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
