import { describe, test, expect } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr029 } from "./azr029";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

describe("AZR029: Disk Missing Encryption", () => {
  test("check metadata", () => {
    expect(azr029.id).toBe("AZR029");
    expect(azr029.description).toBeTruthy();
  });

  test("warns when disk has no encryption", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Compute/disks",
          apiVersion: "2023-04-02",
          name: "myDisk",
          location: "[resourceGroup().location]",
          properties: {
            creationData: { createOption: "Empty" },
            diskSizeGB: 128,
          },
        },
      ],
    });

    const diags = azr029.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR029");
    expect(diags[0].message).toContain("encryption");
  });

  test("no diagnostic when encryption configured", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Compute/disks",
          apiVersion: "2023-04-02",
          name: "myDisk",
          location: "[resourceGroup().location]",
          properties: {
            creationData: { createOption: "Empty" },
            diskSizeGB: 128,
            encryption: { type: "EncryptionAtRestWithPlatformKey" },
          },
        },
      ],
    });

    const diags = azr029.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
