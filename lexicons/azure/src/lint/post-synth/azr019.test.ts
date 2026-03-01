import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr019 } from "./azr019";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR019: SQL Server Missing TDE", () => {
  test("check metadata", () => {
    expect(azr019.id).toBe("AZR019");
    expect(azr019.description).toBeTruthy();
  });

  test("warns when no TDE settings exist for database", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Sql/servers/databases",
          apiVersion: "2022-05-01-preview",
          name: "mySqlServer/myDb",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr019.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR019");
    expect(diags[0].message).toContain("TDE");
  });

  test("no diagnostic when TDE exists", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Sql/servers/databases",
          apiVersion: "2022-05-01-preview",
          name: "mySqlServer/myDb",
          location: "[resourceGroup().location]",
          properties: {},
        },
        {
          type: "Microsoft.Sql/servers/databases/transparentDataEncryption",
          apiVersion: "2022-05-01-preview",
          name: "mySqlServer/myDb/current",
          properties: { status: "Enabled" },
        },
      ],
    });

    const diags = azr019.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
