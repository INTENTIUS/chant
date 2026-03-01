import { describe, it, expect } from "bun:test";
import { azureSerializer } from "./serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";

function makeEntity(entityType: string, props: Record<string, unknown> = {}): any {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "azure",
    entityType,
    kind: "resource",
    props,
  };
}

describe("azureSerializer", () => {
  it("has correct name and rulePrefix", () => {
    expect(azureSerializer.name).toBe("azure");
    expect(azureSerializer.rulePrefix).toBe("AZR");
  });

  it("produces valid ARM template structure", () => {
    const entities = new Map<string, any>();
    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);

    expect(template.$schema).toContain("deploymentTemplate");
    expect(template.contentVersion).toBe("1.0.0.0");
    expect(template.resources).toEqual([]);
  });

  it("serializes a resource with properties", () => {
    const entities = new Map<string, any>();
    entities.set("myStorage", makeEntity("Microsoft.Storage/storageAccounts", {
      name: "teststorage",
      location: "eastus",
      kind: "StorageV2",
      supportsHttpsTrafficOnly: true,
    }));

    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);

    expect(template.resources.length).toBe(1);
    const resource = template.resources[0];
    expect(resource.type).toBe("Microsoft.Storage/storageAccounts");
    expect(resource.apiVersion).toBeTruthy();
    expect(resource.name).toBe("teststorage");
    expect(resource.location).toBe("eastus");
    expect(resource.properties?.supportsHttpsTrafficOnly).toBe(true);
  });

  it("hoists resource-level fields from properties", () => {
    const entities = new Map<string, any>();
    entities.set("myVm", makeEntity("Microsoft.Compute/virtualMachines", {
      name: "testvm",
      location: "westus2",
      sku: { name: "Standard_D2s_v3" },
      kind: "Linux",
      tags: { env: "test" },
    }));

    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);
    const resource = template.resources[0];

    expect(resource.location).toBe("westus2");
    expect(resource.sku).toEqual({ name: "Standard_D2s_v3" });
    expect(resource.kind).toBe("Linux");
    expect(resource.tags).toEqual({ env: "test" });
  });

  it("defaults location to resourceGroup().location", () => {
    const entities = new Map<string, any>();
    entities.set("myVnet", makeEntity("Microsoft.Network/virtualNetworks", {
      name: "testvnet",
    }));

    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);
    const resource = template.resources[0];

    expect(resource.location).toBe("[resourceGroup().location]");
  });

  it("serializes parameters", () => {
    const entities = new Map<string, any>();
    entities.set("env", {
      [DECLARABLE_MARKER]: true,
      lexicon: "azure",
      entityType: "chant:core:parameter",
      kind: "parameter",
      parameterType: "String",
      description: "Runtime environment",
      defaultValue: "dev",
    });

    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);

    expect(template.parameters?.env).toBeTruthy();
    expect(template.parameters.env.type).toBe("string");
    expect(template.parameters.env.defaultValue).toBe("dev");
  });

  it("handles empty entities", () => {
    const entities = new Map<string, any>();
    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);

    expect(template.resources).toEqual([]);
    expect(template.parameters).toBeUndefined();
    expect(template.outputs).toBeUndefined();
  });

  it("serializes CosmosDB nested resources", () => {
    const entities = new Map<string, any>();
    entities.set("cosmosAccount", makeEntity("Microsoft.DocumentDB/databaseAccounts", {
      name: "mycosmosdb",
      location: "eastus",
      kind: "GlobalDocumentDB",
      databaseAccountOfferType: "Standard",
    }));
    entities.set("cosmosDb", makeEntity("Microsoft.DocumentDB/databaseAccounts/sqlDatabases", {
      name: "mycosmosdb/mydb",
    }));
    entities.set("cosmosContainer", makeEntity("Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers", {
      name: "mycosmosdb/mydb/mycontainer",
    }));

    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);

    expect(template.resources).toHaveLength(3);
    const types = template.resources.map((r: any) => r.type);
    expect(types).toContain("Microsoft.DocumentDB/databaseAccounts");
    expect(types).toContain("Microsoft.DocumentDB/databaseAccounts/sqlDatabases");
    expect(types).toContain("Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers");
  });

  it("serializes ServiceBus child resources", () => {
    const entities = new Map<string, any>();
    entities.set("sbNamespace", makeEntity("Microsoft.ServiceBus/namespaces", {
      name: "my-sb",
      location: "eastus",
    }));
    entities.set("sbQueue", makeEntity("Microsoft.ServiceBus/namespaces/queues", {
      name: "my-sb/my-queue",
    }));

    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);

    expect(template.resources).toHaveLength(2);
    const queueResource = template.resources.find((r: any) => r.type === "Microsoft.ServiceBus/namespaces/queues");
    expect(queueResource).toBeDefined();
    expect(queueResource.name).toBe("my-sb/my-queue");
  });

  it("serializes Container Instance with arrays", () => {
    const entities = new Map<string, any>();
    entities.set("ciGroup", makeEntity("Microsoft.ContainerInstance/containerGroups", {
      name: "my-ci",
      location: "eastus",
      osType: "Linux",
      containers: [
        {
          name: "app",
          image: "nginx:latest",
          ports: [{ port: 80 }],
          resources: { requests: { cpu: 1, memoryInGB: 1.5 } },
        },
      ],
    }));

    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);

    expect(template.resources).toHaveLength(1);
    const resource = template.resources[0];
    expect(resource.type).toBe("Microsoft.ContainerInstance/containerGroups");
    expect(resource.properties?.containers).toBeDefined();
    expect(Array.isArray(resource.properties.containers)).toBe(true);
  });

  it("serializes Application Gateway nested properties", () => {
    const entities = new Map<string, any>();
    entities.set("appGw", makeEntity("Microsoft.Network/applicationGateways", {
      name: "my-appgw",
      location: "eastus",
      sku: { name: "WAF_v2", tier: "WAF_v2", capacity: 2 },
      gatewayIPConfigurations: [{ name: "config", subnet: { id: "subnet-id" } }],
      frontendIPConfigurations: [{ name: "frontend", publicIPAddress: { id: "pip-id" } }],
    }));

    const result = azureSerializer.serialize(entities);
    const template = JSON.parse(result as string);

    expect(template.resources).toHaveLength(1);
    const resource = template.resources[0];
    expect(resource.type).toBe("Microsoft.Network/applicationGateways");
    expect(resource.sku).toEqual({ name: "WAF_v2", tier: "WAF_v2", capacity: 2 });
  });
});
