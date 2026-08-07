import { describe, it, expect } from "vitest";
import { getCachePath, explodeProviderSchema, type ArmProviderSchema } from "./fetch";

describe("fetchArmSchemas", () => {
  it("returns a valid cache path", () => {
    const path = getCachePath();
    expect(path).toContain(".chant");
    expect(path).toContain("azure-resource-manager-schemas");
  });
});

function parseEntry(out: Map<string, Buffer>, resourceType: string) {
  const buf = out.get(resourceType);
  expect(buf).toBeTruthy();
  return JSON.parse(buf!.toString("utf-8"));
}

describe("explodeProviderSchema (#1545)", () => {
  it("reads only resourceDefinitions for a non-allowlisted provider", () => {
    const schema: ArmProviderSchema = {
      resourceDefinitions: { storageAccounts: { type: "object" } },
      subscription_resourceDefinitions: { subscriptionOnly: { type: "object" } },
      definitions: {},
    };
    const out = new Map<string, Buffer>();
    explodeProviderSchema("Microsoft.Storage", "2023-06-01", schema, out);

    expect([...out.keys()]).toEqual(["Microsoft.Storage/storageAccounts"]);
    const entry = parseEntry(out, "Microsoft.Storage/storageAccounts");
    expect(entry.deployScopes).toEqual(["resourceGroup"]);
    expect(entry.apiVersion).toBe("2023-06-01");
  });

  it("reads scope sections for allowlisted providers and unions scopes", () => {
    const schema: ArmProviderSchema = {
      resourceDefinitions: { policyAssignments: { type: "object" } },
      subscription_resourceDefinitions: {
        policyAssignments: { type: "object" },
        policyDefinitions: { type: "object" },
      },
      managementGroup_resourceDefinitions: { policyDefinitions: { type: "object" } },
      tenant_resourceDefinitions: { policyAssignments: { type: "object" } },
      definitions: {},
    };
    const out = new Map<string, Buffer>();
    explodeProviderSchema("Microsoft.Authorization", "2026-06-01", schema, out);

    const assignments = parseEntry(out, "Microsoft.Authorization/policyAssignments");
    expect(assignments.deployScopes).toEqual(["resourceGroup", "subscription", "tenant"]);
    const definitions = parseEntry(out, "Microsoft.Authorization/policyDefinitions");
    expect(definitions.deployScopes).toEqual(["subscription", "managementGroup"]);
  });

  it("reads tenant-only resources like management groups", () => {
    const schema: ArmProviderSchema = {
      tenant_resourceDefinitions: {
        managementGroups: { type: "object" },
        managementGroups_subscriptions: { type: "object" },
      },
      definitions: {},
    };
    const out = new Map<string, Buffer>();
    explodeProviderSchema("Microsoft.Management", "2023-04-01", schema, out);

    const mg = parseEntry(out, "Microsoft.Management/managementGroups");
    expect(mg.deployScopes).toEqual(["tenant"]);
    expect(out.has("Microsoft.Management/managementGroups_subscriptions")).toBe(true);
  });

  it("keeps the first definition of a resource across a multi-version pin", () => {
    const out = new Map<string, Buffer>();
    explodeProviderSchema("Microsoft.Authorization", "2022-04-01", {
      resourceDefinitions: { roleAssignments: { description: "roles file" } },
      definitions: {},
    }, out);
    explodeProviderSchema("Microsoft.Authorization", "2026-06-01", {
      resourceDefinitions: { roleAssignments: { description: "policy file" }, policyAssignments: {} },
      definitions: {},
    }, out);

    const roles = parseEntry(out, "Microsoft.Authorization/roleAssignments");
    expect(roles.apiVersion).toBe("2022-04-01");
    expect(roles.resourceDefinition.description).toBe("roles file");
    // The later file still contributes resources the first one lacked
    const policy = parseEntry(out, "Microsoft.Authorization/policyAssignments");
    expect(policy.apiVersion).toBe("2026-06-01");
  });
});
