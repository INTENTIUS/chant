import { describe, it, expect } from "vitest";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { azureGraphEdges } from "./graph-edges";
import { azureSerializer } from "./serializer";
import { ListKeys, Reference, ResourceId } from "./intrinsics";

function makeEntity(entityType: string, props: Record<string, unknown> = {}): any {
  return { [DECLARABLE_MARKER]: true, lexicon: "azure", entityType, kind: "resource", props };
}

/** behold's three-cloud Azure member, cut down to the two references in #4232. */
function threeCloud(): Map<string, any> {
  const entities = new Map<string, any>();
  entities.set("logs", makeEntity("Microsoft.OperationalInsights/workspaces", { name: "logs", location: "eastus" }));
  entities.set("appIdentity", makeEntity("Microsoft.ManagedIdentity/userAssignedIdentities", { name: "app-id", location: "eastus" }));
  entities.set("env", makeEntity("Microsoft.App/managedEnvironments", {
    name: "env",
    location: "eastus",
    appLogsConfiguration: {
      destination: "log-analytics",
      logAnalyticsConfiguration: {
        customerId: "[reference(resourceId('Microsoft.OperationalInsights/workspaces', 'logs')).customerId]",
        sharedKey: ListKeys(ResourceId("Microsoft.OperationalInsights/workspaces", "logs"), "2022-10-01"),
      },
    },
  }));
  entities.set("app", makeEntity("Microsoft.App/containerApps", {
    name: "web",
    location: "eastus",
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: {
        "[resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'app-id')]": {},
      },
    },
    managedEnvironmentId: Reference("env"),
  }));
  return entities;
}

describe("azureGraphEdges (#4232)", () => {
  it("draws env -> logs from reference(resourceId(...)) and listKeys(...)", () => {
    const refs = azureGraphEdges(threeCloud())!.references;
    expect(refs).toContainEqual({ from: "env", to: "logs", kind: "ref", viaAttr: "appLogsConfiguration" });
    expect(refs.filter((r) => r.from === "env" && r.to === "logs")).toHaveLength(1);
  });

  it("draws app -> identity from a resourceId(...) object key, by the identity's ARM name", () => {
    const refs = azureGraphEdges(threeCloud())!.references;
    expect(refs).toContainEqual({ from: "app", to: "appIdentity", kind: "ref", viaAttr: "identity" });
    expect(refs).toContainEqual({ from: "app", to: "env", kind: "ref", viaAttr: "managedEnvironmentId" });
  });

  it("agrees with the dependsOn the serializer writes", () => {
    const entities = threeCloud();
    const template = JSON.parse(azureSerializer.serialize(entities) as string);
    const keyOfName = new Map<string, string>([["logs", "logs"], ["app-id", "appIdentity"], ["env", "env"], ["web", "app"]]);
    const fromTemplate = new Set<string>();
    for (const r of template.resources) {
      for (const dep of r.dependsOn ?? []) {
        const name = /'([^']+)'\)\]$/.exec(dep)![1];
        fromTemplate.add(`${keyOfName.get(r.name)}->${keyOfName.get(name)}`);
      }
    }
    const fromGraph = new Set(azureGraphEdges(entities)!.references.map((r) => `${r.from}->${r.to}`));
    expect(fromGraph).toEqual(fromTemplate);
    expect(fromGraph).toEqual(new Set(["env->logs", "app->appIdentity", "app->env"]));
  });

  it("matches a child resource by name whichever way its type is spelled, and links it to its parent", () => {
    const entities = new Map<string, any>();
    entities.set("vnet", makeEntity("Microsoft.Network/virtualNetworks", { name: "vnet", location: "eastus" }));
    entities.set("apps", makeEntity("Microsoft.Network/virtualNetworks_subnets", { name: "vnet/apps" }));
    entities.set("nic", makeEntity("Microsoft.Network/networkInterfaces", {
      name: "nic",
      location: "eastus",
      ipConfigurations: [{ name: "ip", properties: { subnet: { id: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'apps')]" } } }],
    }));
    const refs = azureGraphEdges(entities)!.references;
    expect(refs).toContainEqual({ from: "nic", to: "apps", kind: "ref", viaAttr: "ipConfigurations" });
    expect(refs).toContainEqual({ from: "apps", to: "vnet", kind: "ref", viaAttr: "name" });
  });

  it("leaves out a name nothing declares, and returns nothing without azure resources", () => {
    const entities = new Map<string, any>();
    entities.set("app", makeEntity("Microsoft.Web/sites", {
      name: "site",
      location: "eastus",
      serverFarmId: "[resourceId('Microsoft.Web/serverfarms', 'existing-plan')]",
    }));
    expect(azureGraphEdges(entities)).toBeUndefined();
    expect(azureGraphEdges(new Map())).toBeUndefined();
  });
});
