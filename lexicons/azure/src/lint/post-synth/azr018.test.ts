import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr018 } from "./azr018";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR018: SQL Server Missing Auditing", () => {
  test("check metadata", () => {
    expect(azr018.id).toBe("AZR018");
    expect(azr018.description).toBeTruthy();
  });

  test("warns when no auditing settings exist", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Sql/servers",
          apiVersion: "2022-05-01-preview",
          name: "mySqlServer",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr018.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR018");
    expect(diags[0].message).toContain("auditing");
  });

  test("no diagnostic when auditing settings exist", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Sql/servers",
          apiVersion: "2022-05-01-preview",
          name: "mySqlServer",
          location: "[resourceGroup().location]",
          properties: {},
        },
        {
          type: "Microsoft.Sql/servers/auditingSettings",
          apiVersion: "2022-05-01-preview",
          name: "mySqlServer/default",
          properties: { state: "Enabled" },
        },
      ],
    });

    const diags = azr018.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
