import { describe, it, expect } from "vitest";
import { NamingStrategy } from "./naming";
import type { ArmSchemaParseResult } from "../spec/parse";

function makeResult(typeName: string): ArmSchemaParseResult {
  return {
    resource: {
      typeName,
      apiVersion: "2023-01-01",
      properties: [],
      attributes: [],
      resourceLevelFields: [],
    },
    propertyTypes: [],
    enums: [],
  };
}

describe("NamingStrategy", () => {
  it("resolves priority names", () => {
    const results = [
      makeResult("Microsoft.Storage/storageAccounts"),
      makeResult("Microsoft.Compute/virtualMachines"),
    ];
    const naming = new NamingStrategy(results);

    expect(naming.resolve("Microsoft.Storage/storageAccounts")).toBe("StorageAccount");
    expect(naming.resolve("Microsoft.Compute/virtualMachines")).toBe("VirtualMachine");
  });

  it("provides aliases for resources with multiple names", () => {
    const results = [makeResult("Microsoft.Web/sites")];
    const naming = new NamingStrategy(results);

    expect(naming.resolve("Microsoft.Web/sites")).toBe("WebApp");
    expect(naming.aliases("Microsoft.Web/sites")).toContain("AppService");
  });
});
