import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { azureSerializer } from "@intentius/chant-lexicon-azure";
import { expect } from "bun:test";

/**
 * armChecks — validates ARM template resources by searching the resources
 * array by `type` field (unlike AWS which uses keyed objects).
 */
function armChecks(
  expectations: {
    resourceTypes?: string[];
    resourceCount?: number;
  },
) {
  return (output: string) => {
    const parsed = JSON.parse(output);
    expect(parsed.$schema).toContain("deploymentTemplate");
    expect(parsed.resources).toBeDefined();
    expect(Array.isArray(parsed.resources)).toBe(true);

    if (expectations.resourceTypes) {
      const types = parsed.resources.map((r: Record<string, unknown>) => r.type);
      for (const t of expectations.resourceTypes) {
        expect(types).toContain(t);
      }
    }
    if (expectations.resourceCount !== undefined) {
      expect(parsed.resources).toHaveLength(expectations.resourceCount);
    }
  };
}

describeAllExamples(
  {
    lexicon: "azure",
    serializer: azureSerializer,
    outputKey: "azure",
    examplesDir: import.meta.dir,
  },
  {
    "web-app": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.Web/serverfarms",
          "Microsoft.Web/sites",
        ],
        resourceCount: 2,
      }),
    },
    "aks-cluster": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.ContainerService/managedClusters",
          "Microsoft.ContainerRegistry/registries",
          "Microsoft.Network/virtualNetworks",
        ],
      }),
    },
    "basic-storage": {
      checks: armChecks({
        resourceTypes: ["Microsoft.Storage/storageAccounts"],
        resourceCount: 1,
      }),
    },
    "vnet-vms": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.Network/virtualNetworks",
          "Microsoft.Compute/virtualMachines",
        ],
      }),
    },
    "multi-resource": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.Storage/storageAccounts",
        ],
      }),
    },
    "function-app": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.Web/serverfarms",
          "Microsoft.Web/sites",
          "Microsoft.Storage/storageAccounts",
        ],
        resourceCount: 3,
      }),
    },
    "service-bus": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.ServiceBus/namespaces",
          "Microsoft.ServiceBus/namespaces/queues",
        ],
        resourceCount: 2,
      }),
    },
    "cosmos-db": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.DocumentDB/databaseAccounts",
          "Microsoft.DocumentDB/databaseAccounts/sqlDatabases",
          "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers",
        ],
        resourceCount: 3,
      }),
    },
    "container-instance": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.ContainerInstance/containerGroups",
        ],
        resourceCount: 1,
      }),
    },
    "sql-database": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.Sql/servers",
          "Microsoft.Sql/servers/databases",
          "Microsoft.Sql/servers/firewallRules",
        ],
        resourceCount: 3,
      }),
    },
    "key-vault": {
      checks: armChecks({
        resourceTypes: ["Microsoft.KeyVault/vaults"],
        resourceCount: 1,
      }),
    },
    "redis-cache": {
      checks: armChecks({
        resourceTypes: ["Microsoft.Cache/redis"],
        resourceCount: 1,
      }),
    },
    "private-endpoint": {
      checks: armChecks({
        resourceTypes: [
          "Microsoft.Network/privateEndpoints",
          "Microsoft.Network/privateDnsZones",
          "Microsoft.Storage/storageAccounts",
          "Microsoft.Network/virtualNetworks",
        ],
      }),
    },
  },
);
