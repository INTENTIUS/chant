import { describe, expect, test } from "vitest";
import { parseExportedTemplate } from "./live-export";
import { ArmGenerator } from "./generator";

// Mimics what `az group export --output json` returns: an ARM template object.
const liveTemplate = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.Storage/storageAccounts",
      apiVersion: "2021-09-01",
      name: "mystore",
      location: "eastus",
      properties: { accessTier: "Hot" },
    },
    {
      type: "Microsoft.Network/virtualNetworks",
      apiVersion: "2021-05-01",
      name: "myvnet",
      location: "eastus",
      properties: {},
    },
  ],
};

describe("azure exportResources mapping (#159)", () => {
  test("maps a live ARM template to export IR", () => {
    const ir = parseExportedTemplate(liveTemplate);
    expect(ir.resources.map((r) => r.logicalId).sort()).toEqual(["mystore", "myvnet"]);
    const store = ir.resources.find((r) => r.logicalId === "mystore")!;
    expect(store.type).toBe("Microsoft.Storage/storageAccounts");
    expect(store.properties.accessTier).toBe("Hot");
    expect(store.properties.location).toBe("eastus");
  });

  test("accepts a stringified template body", () => {
    const ir = parseExportedTemplate(JSON.stringify(liveTemplate));
    expect(ir.resources).toHaveLength(2);
  });

  test("selector by name narrows the export", () => {
    const ir = parseExportedTemplate(liveTemplate, { name: "myvnet" });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["myvnet"]);
  });

  test("selector by type narrows the export", () => {
    const ir = parseExportedTemplate(liveTemplate, {
      type: "Microsoft.Storage/storageAccounts",
    });
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["mystore"]);
  });

  test("owned filter keeps only resources carrying the chant marker (#120)", () => {
    const mixed = {
      $schema: liveTemplate.$schema,
      contentVersion: "1.0.0.0",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2021-09-01",
          name: "mine",
          location: "eastus",
          tags: { "chant-managed-by": "chant", "chant-stack": "billing" },
          properties: {},
        },
        {
          type: "Microsoft.Storage/storageAccounts",
          apiVersion: "2021-09-01",
          name: "theirs",
          location: "eastus",
          tags: { team: "other" },
          properties: {},
        },
      ],
    };
    const ir = parseExportedTemplate(mixed, undefined, true);
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["mine"]);
  });

  test("no selector and not owned → full passthrough", () => {
    const ir = parseExportedTemplate(liveTemplate, {}, false);
    expect(ir.resources).toHaveLength(2);
  });

  test("export IR feeds ArmGenerator (templateGenerator) unchanged", () => {
    const ir = parseExportedTemplate(liveTemplate);
    const files = new ArmGenerator().generate(ir);
    expect(files.length).toBeGreaterThan(0);
    const all = files.map((f) => f.content).join("\n");
    expect(all).toContain("mystore");
  });
});
