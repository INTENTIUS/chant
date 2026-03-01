import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr024 } from "./azr024";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR024: VM Missing Boot Diagnostics", () => {
  test("check metadata", () => {
    expect(azr024.id).toBe("AZR024");
    expect(azr024.description).toBeTruthy();
  });

  test("warns when boot diagnostics not enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Compute/virtualMachines",
          apiVersion: "2023-07-01",
          name: "myVm",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr024.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR024");
    expect(diags[0].message).toContain("boot diagnostics");
  });

  test("no diagnostic when boot diagnostics enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Compute/virtualMachines",
          apiVersion: "2023-07-01",
          name: "myVm",
          location: "[resourceGroup().location]",
          properties: {
            diagnosticsProfile: {
              bootDiagnostics: { enabled: true },
            },
          },
        },
      ],
    });

    const diags = azr024.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
