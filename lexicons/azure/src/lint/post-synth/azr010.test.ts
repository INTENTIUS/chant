import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr010 } from "./azr010";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR010: Redundant DependsOn", () => {
  test("check metadata", () => {
    expect(azr010.id).toBe("AZR010");
    expect(azr010.description).toBeTruthy();
  });

  test("detects redundant DependsOn from reference", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2023-01-01",
          name: "myApp",
          location: "[resourceGroup().location]",
          dependsOn: ["myStorage"],
          properties: {
            storageRef: "[reference('myStorage')]",
          },
        },
      ],
    });

    const diags = azr010.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR010");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("redundant dependsOn");
    expect(diags[0].message).toContain("myStorage");
  });

  test("no diagnostic when DependsOn is not redundant", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2023-01-01",
          name: "myApp",
          location: "[resourceGroup().location]",
          dependsOn: ["myVnet"],
          properties: {
            storageRef: "[reference('myStorage')]",
          },
        },
      ],
    });

    const diags = azr010.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
