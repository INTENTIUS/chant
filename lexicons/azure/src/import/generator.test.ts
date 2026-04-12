import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ArmGenerator } from "./generator";
import type { TemplateIR } from "@intentius/chant/import/parser";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hasMeta = existsSync(join(pkgDir, "dist", "meta.json"));

describe("ArmGenerator", () => {
  const generator = new ArmGenerator();

  it("generates a main.ts file from a simple IR", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "myStorage",
          type: "Microsoft.Storage/storageAccounts",
          properties: {
            location: { __intrinsic: "ResourceGroup", property: "location" },
            kind: "StorageV2",
            sku: { name: "Standard_LRS" },
            supportsHttpsTrafficOnly: true,
          },
        },
      ],
    };

    const files = generator.generate(ir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile).toBeDefined();
    // Without dist/meta.json, resource types are commented as "Unknown"
    // With meta.json, they produce typed import statements
    expect(mainFile!.content).toContain("myStorage");
  });

  it.skipIf(!hasMeta)("generates import from lexicon when meta.json available", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "myStorage",
          type: "Microsoft.Storage/storageAccounts",
          properties: {
            location: { __intrinsic: "ResourceGroup", property: "location" },
          },
        },
      ],
    };

    const files = generator.generate(ir);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile!.content).toContain("@intentius/chant-lexicon-azure");
  });

  it("generates Azure pseudo-parameter references", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "myStorage",
          type: "Microsoft.Storage/storageAccounts",
          properties: {
            location: { __intrinsic: "ResourceGroup", property: "location" },
          },
        },
      ],
    };

    const files = generator.generate(ir);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile!.content).toContain("Azure");
  });

  it("generates main.ts file path", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "myStorage",
          type: "Microsoft.Storage/storageAccounts",
          properties: {},
        },
      ],
    };

    const files = generator.generate(ir);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile).toBeDefined();
  });

  it("handles empty resources array", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [],
    };

    const files = generator.generate(ir);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("generates multi-resource output", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "myStorage",
          type: "Microsoft.Storage/storageAccounts",
          properties: { location: "eastus" },
        },
        {
          logicalId: "myApp",
          type: "Microsoft.Web/sites",
          properties: { httpsOnly: true },
          dependsOn: ["myStorage"],
        },
      ],
    };

    const files = generator.generate(ir);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile!.content).toContain("myStorage");
    expect(mainFile!.content).toContain("myApp");
  });

  it("generates camelCase variable names", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "MyStorage",
          type: "Microsoft.Storage/storageAccounts",
          properties: {},
        },
      ],
    };

    const files = generator.generate(ir);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile!.content).toContain("myStorage");
  });

  it("handles boolean and number values", () => {
    const ir: TemplateIR = {
      parameters: [],
      resources: [
        {
          logicalId: "myStorage",
          type: "Microsoft.Storage/storageAccounts",
          properties: {
            supportsHttpsTrafficOnly: true,
            maxSize: 1024,
          },
        },
      ],
    };

    const files = generator.generate(ir);
    const mainFile = files.find((f) => f.path === "main.ts");
    expect(mainFile!.content).toContain("true");
    expect(mainFile!.content).toContain("1024");
  });
});
