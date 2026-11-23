import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { NamingStrategy, publishedNames } from "./naming";
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

describe("published names stay with the type that published them (#5551)", () => {
  const resolveAll = (types: string[], reserved?: Record<string, string>) => {
    const naming = new NamingStrategy(types.map(makeResult), reserved);
    return Object.fromEntries(types.map((t) => [t, naming.resolve(t)]));
  };

  it("with the committed snapshot, a newcomer sharing a published short name is prefixed and the published type keeps its name", () => {
    const reserved = publishedNames();
    expect(reserved["Microsoft.AppPlatform/Spring"]).toBe("Spring");
    expect(reserved["Microsoft.Devices/IotHubs"]).toBe("IotHubs");

    const types = [
      "Microsoft.Contoso/Spring",
      "Microsoft.AppPlatform/Spring",
      "Microsoft.Devices/IotHubs",
      "Microsoft.Fabrikam/IotHubs",
    ];
    const names = resolveAll(types, reserved);
    expect(names).toEqual({
      "Microsoft.Contoso/Spring": "ContosoSpring",
      "Microsoft.AppPlatform/Spring": "Spring",
      "Microsoft.Devices/IotHubs": "IotHubs",
      "Microsoft.Fabrikam/IotHubs": "FabrikamIotHubs",
    });
    expect(resolveAll([...types].reverse(), reserved)).toEqual(names);
  });

  it("without published names, the same input renames the published type, as the rule alone did", () => {
    expect(resolveAll(["Microsoft.AppPlatform/Spring", "Microsoft.Contoso/Spring"])["Microsoft.AppPlatform/Spring"]).toBe(
      "AppPlatformSpring",
    );
  });

  it("a newcomer whose short name only prefixed published types share is still prefixed", () => {
    const reserved = {
      "Microsoft.Advisor/configurations": "Advisorconfigurations",
      "Microsoft.Edge/configurations": "Edgeconfigurations",
    };
    expect(
      resolveAll(["Microsoft.Advisor/configurations", "Microsoft.Edge/configurations", "Microsoft.Contoso/configurations"], reserved),
    ).toEqual({
      "Microsoft.Advisor/configurations": "Advisorconfigurations",
      "Microsoft.Edge/configurations": "Edgeconfigurations",
      "Microsoft.Contoso/configurations": "Contosoconfigurations",
    });
  });

  it("a type the snapshot lists under its alias keeps its priority name and the alias", () => {
    const naming = new NamingStrategy([makeResult("Microsoft.Web/sites")], publishedNames());
    expect(naming.resolve("Microsoft.Web/sites")).toBe("WebApp");
    expect(naming.aliases("Microsoft.Web/sites")).toContain("AppService");
  });

  it("a missing snapshot reserves nothing", () => {
    expect(publishedNames(join(import.meta.dirname, "no-such-dir", "surface.snapshot.json"))).toEqual({});
  });
});
