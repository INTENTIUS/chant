import { describe, expect, test } from "bun:test";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { azr010 } from "./azr010";
import { azr011 } from "./azr011";
import { azr012 } from "./azr012";
import { azr013 } from "./azr013";
import { azr014 } from "./azr014";
import { azr015 } from "./azr015";
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
