import { describe, expect, test } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr010 } from "./azr010";
import { azr011 } from "./azr011";
import { azr012 } from "./azr012";
import { azr013 } from "./azr013";
import { azr014 } from "./azr014";
import { azr015 } from "./azr015";
import { azr016 } from "./azr016";
import { azr017 } from "./azr017";
import { azr018 } from "./azr018";
import { azr019 } from "./azr019";
import { azr020 } from "./azr020";
import { azr021 } from "./azr021";
import { azr022 } from "./azr022";
import { azr023 } from "./azr023";
import { azr024 } from "./azr024";
import { azr025 } from "./azr025";
import { azr026 } from "./azr026";
import { azr027 } from "./azr027";
import { azr028 } from "./azr028";
import { azr029 } from "./azr029";
import { findArmResourceRefs, parseArmTemplate, extractRefsFromExpression, isBracketExpression } from "./arm-refs";

function makeCtx(template: object) {
  return createPostSynthContext({ azure: template });
}

// --- arm-refs utility tests ---

describe("findArmResourceRefs", () => {
  test("extracts resourceId targets", () => {
    const refs = findArmResourceRefs({
      subnet: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'myVnet', 'mySubnet')]",
    });
    expect(refs.has("mySubnet")).toBe(true);
  });

  test("extracts reference targets", () => {
    const refs = findArmResourceRefs({
      key: "[reference('myStorage').primaryEndpoints.blob]",
    });
    expect(refs.has("myStorage")).toBe(true);
  });

  test("recurses into nested structures", () => {
    const refs = findArmResourceRefs({
      prop1: {
        nested: "[reference('A')]",
      },
      prop2: ["[resourceId('Microsoft.Storage/storageAccounts', 'B')]"],
    });
    expect(refs.has("A")).toBe(true);
    expect(refs.has("B")).toBe(true);
  });
});

describe("isBracketExpression", () => {
  test("detects bracket expressions", () => {
    expect(isBracketExpression("[resourceId('x', 'y')]")).toBe(true);
    expect(isBracketExpression("[resourceGroup().location]")).toBe(true);
  });

  test("rejects non-bracket strings", () => {
    expect(isBracketExpression("plain string")).toBe(false);
    expect(isBracketExpression(42)).toBe(false);
    expect(isBracketExpression(null)).toBe(false);
  });
});

describe("extractRefsFromExpression", () => {
  test("extracts from resourceId expression", () => {
    const refs = extractRefsFromExpression("[resourceId('Microsoft.Storage/storageAccounts', 'myStorage')]");
    expect(refs).toContain("myStorage");
  });

  test("extracts from reference expression", () => {
    const refs = extractRefsFromExpression("[reference('myResource')]");
    expect(refs).toContain("myResource");
  });
});

describe("parseArmTemplate", () => {
  test("parses valid JSON", () => {
    const t = parseArmTemplate('{"resources":[]}');
    expect(t).toBeTruthy();
    expect(t!.resources).toEqual([]);
  });

  test("returns null for invalid JSON", () => {
    expect(parseArmTemplate("not json")).toBeNull();
  });
});

// --- AZR010: Redundant DependsOn ---

describe("AZR010: Redundant DependsOn", () => {
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

// --- AZR011: Missing or Invalid API Version ---

describe("AZR011: Missing or Invalid API Version", () => {
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

// --- AZR012: Deprecated API Version ---

describe("AZR012: Deprecated API Version", () => {
  test("warns for old apiVersion", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2021-04-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
        },
      ],
    });

    const diags = azr012.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR012");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("outdated apiVersion");
  });

  test("no diagnostic for recent apiVersion", () => {
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

    const diags = azr012.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR013: Resource Missing Location ---

describe("AZR013: Resource Missing Location", () => {
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

// --- AZR014: Public Blob Access Enabled ---

describe("AZR014: Public Blob Access Enabled", () => {
  test("warns when allowBlobPublicAccess is true", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: { allowBlobPublicAccess: true },
        },
      ],
    });

    const diags = azr014.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR014");
    expect(diags[0].message).toContain("allowBlobPublicAccess");
  });

  test("warns when allowBlobPublicAccess is not set", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr014.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("no diagnostic when allowBlobPublicAccess is false", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: { allowBlobPublicAccess: false },
        },
      ],
    });

    const diags = azr014.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("ignores non-storage resources", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Compute/virtualMachines",
          apiVersion: "2023-05-01",
          name: "myVm",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr014.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR015: Missing Encryption on Storage Account ---

describe("AZR015: Missing Encryption", () => {
  test("warns when no encryption configured", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr015.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR015");
    expect(diags[0].message).toContain("no encryption");
  });

  test("warns when encryption services missing blob", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: {
            encryption: {
              services: { file: { enabled: true } },
            },
          },
        },
      ],
    });

    const diags = azr015.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("blob");
  });

  test("no diagnostic with full encryption", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2023-05-01",
          name: "myStorage",
          location: "[resourceGroup().location]",
          properties: {
            encryption: {
              services: {
                blob: { enabled: true },
                file: { enabled: true },
              },
            },
          },
        },
      ],
    });

    const diags = azr015.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR016: Key Vault Soft Delete ---

describe("AZR016: Key Vault Soft Delete", () => {
  test("warns when soft delete is not enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.KeyVault/vaults",
          apiVersion: "2023-02-01",
          name: "myVault",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr016.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR016");
    expect(diags[0].message).toContain("soft-delete");
  });

  test("no diagnostic when soft delete is enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.KeyVault/vaults",
          apiVersion: "2023-02-01",
          name: "myVault",
          location: "[resourceGroup().location]",
          properties: { enableSoftDelete: true },
        },
      ],
    });

    const diags = azr016.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR017: Key Vault Purge Protection ---

describe("AZR017: Key Vault Purge Protection", () => {
  test("warns when purge protection is not enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.KeyVault/vaults",
          apiVersion: "2023-02-01",
          name: "myVault",
          location: "[resourceGroup().location]",
          properties: { enableSoftDelete: true },
        },
      ],
    });

    const diags = azr017.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR017");
    expect(diags[0].message).toContain("purge protection");
  });

  test("no diagnostic when purge protection is enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.KeyVault/vaults",
          apiVersion: "2023-02-01",
          name: "myVault",
          location: "[resourceGroup().location]",
          properties: { enableSoftDelete: true, enablePurgeProtection: true },
        },
      ],
    });

    const diags = azr017.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR018: SQL Server Missing Auditing ---

describe("AZR018: SQL Server Missing Auditing", () => {
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

// --- AZR019: SQL Server Missing TDE ---

describe("AZR019: SQL Server Missing TDE", () => {
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

// --- AZR020: App Service Missing Managed Identity ---

describe("AZR020: App Service Missing Managed Identity", () => {
  test("warns when no identity configured", () => {
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

    const diags = azr020.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR020");
    expect(diags[0].message).toContain("managed identity");
  });

  test("no diagnostic when SystemAssigned identity exists", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Web/sites",
          apiVersion: "2022-09-01",
          name: "myApp",
          location: "[resourceGroup().location]",
          identity: { type: "SystemAssigned" },
          properties: {},
        },
      ],
    });

    const diags = azr020.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR021: App Service Missing HTTPS-Only ---

describe("AZR021: App Service Missing HTTPS-Only", () => {
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

// --- AZR022: App Service Missing Minimum TLS 1.2 ---

describe("AZR022: App Service Missing Minimum TLS 1.2", () => {
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

// --- AZR023: VM Missing Managed Disk ---

describe("AZR023: VM Missing Managed Disk", () => {
  test("warns when OS disk has no managedDisk", () => {
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
            storageProfile: {
              osDisk: { createOption: "FromImage" },
            },
          },
        },
      ],
    });

    const diags = azr023.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR023");
    expect(diags[0].message).toContain("managed disks");
  });

  test("no diagnostic when managedDisk is configured", () => {
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
            storageProfile: {
              osDisk: {
                createOption: "FromImage",
                managedDisk: { storageAccountType: "Premium_LRS" },
              },
            },
          },
        },
      ],
    });

    const diags = azr023.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR024: VM Missing Boot Diagnostics ---

describe("AZR024: VM Missing Boot Diagnostics", () => {
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

// --- AZR025: AKS Missing RBAC ---

describe("AZR025: AKS Missing RBAC", () => {
  test("warns when RBAC not enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerService/managedClusters",
          apiVersion: "2023-08-01",
          name: "myAks",
          location: "[resourceGroup().location]",
          properties: {},
        },
      ],
    });

    const diags = azr025.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR025");
    expect(diags[0].message).toContain("RBAC");
  });

  test("no diagnostic when RBAC enabled", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerService/managedClusters",
          apiVersion: "2023-08-01",
          name: "myAks",
          location: "[resourceGroup().location]",
          properties: { enableRBAC: true },
        },
      ],
    });

    const diags = azr025.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR026: AKS Missing Network Policy ---

describe("AZR026: AKS Missing Network Policy", () => {
  test("warns when no network policy configured", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerService/managedClusters",
          apiVersion: "2023-08-01",
          name: "myAks",
          location: "[resourceGroup().location]",
          properties: {
            networkProfile: { networkPlugin: "azure" },
          },
        },
      ],
    });

    const diags = azr026.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR026");
    expect(diags[0].message).toContain("network policy");
  });

  test("no diagnostic when network policy set", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.ContainerService/managedClusters",
          apiVersion: "2023-08-01",
          name: "myAks",
          location: "[resourceGroup().location]",
          properties: {
            networkProfile: { networkPlugin: "azure", networkPolicy: "azure" },
          },
        },
      ],
    });

    const diags = azr026.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR027: Container Registry Admin Enabled ---

describe("AZR027: Container Registry Admin Enabled", () => {
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

// --- AZR028: Network Interface Missing NSG ---

describe("AZR028: Network Interface Missing NSG", () => {
  test("warns when NIC has no NSG", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Network/networkInterfaces",
          apiVersion: "2023-05-01",
          name: "myNic",
          location: "[resourceGroup().location]",
          properties: {
            ipConfigurations: [{ name: "ipconfig1", properties: {} }],
          },
        },
      ],
    });

    const diags = azr028.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("AZR028");
    expect(diags[0].message).toContain("NSG");
  });

  test("no diagnostic when NSG is associated", () => {
    const ctx = makeCtx({
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Network/networkInterfaces",
          apiVersion: "2023-05-01",
          name: "myNic",
          location: "[resourceGroup().location]",
          properties: {
            ipConfigurations: [{ name: "ipconfig1", properties: {} }],
            networkSecurityGroup: { id: "[resourceId('Microsoft.Network/networkSecurityGroups', 'myNsg')]" },
          },
        },
      ],
    });

    const diags = azr028.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// --- AZR029: Disk Missing Encryption ---

describe("AZR029: Disk Missing Encryption", () => {
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
