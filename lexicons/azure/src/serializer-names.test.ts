/**
 * References use the ARM name, not the chant export name, and an explicit
 * `properties` object is merged, not nested (#4183).
 */

import { describe, expect, it } from "vitest";
import { AttrRef } from "@intentius/chant";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { azureSerializer } from "./serializer";

function makeEntity(entityType: string, props: Record<string, unknown> = {}): any {
  return { [DECLARABLE_MARKER]: true, lexicon: "azure", entityType, kind: "resource", props };
}

function ref(parent: object, logicalName: string, attribute: string): AttrRef {
  const r = new AttrRef(parent, attribute);
  r._setLogicalName(logicalName);
  return r;
}

function serialize(entities: Map<string, any>): any {
  return JSON.parse(azureSerializer.serialize(entities) as string);
}

describe("azure references by ARM name", () => {
  it("reads reference() and resourceId() by the name prop, and infers dependsOn from them", () => {
    const env = makeEntity("Microsoft.App/managedEnvironments", { name: "prod-env", location: "eastus" });
    const entities = new Map<string, any>([["env", env]]);
    entities.set("app", makeEntity("Microsoft.App/containerApps", {
      name: "web",
      location: "eastus",
      environmentId: ref(env, "env", "id"),
      envName: ref(env, "env", "defaultDomain"),
    }));

    const app = serialize(entities).resources.find((r: any) => r.name === "web");
    expect(app.properties.environmentId).toBe("[resourceId('Microsoft.App/managedEnvironments', 'prod-env')]");
    expect(app.properties.envName).toBe("[reference('prod-env').defaultDomain]");
    expect(app.dependsOn).toEqual(["[resourceId('Microsoft.App/managedEnvironments', 'prod-env')]"]);
  });

  it("falls back to the export name when there is no name prop", () => {
    const vnet = makeEntity("Microsoft.Network/virtualNetworks", { location: "eastus" });
    const entities = new Map<string, any>([["vnet", vnet]]);
    entities.set("nic", makeEntity("Microsoft.Network/networkInterfaces", { name: "nic", vnetId: ref(vnet, "vnet", "id") }));

    const nic = serialize(entities).resources.find((r: any) => r.name === "nic");
    expect(nic.properties.vnetId).toBe("[resourceId('Microsoft.Network/virtualNetworks', 'vnet')]");
  });

  it("splits a child resource's name into resourceId segments", () => {
    const subnet = makeEntity("Microsoft.Network/virtualNetworks/subnets", { name: "vnet/apps" });
    const entities = new Map<string, any>([["subnet", subnet]]);
    entities.set("nic", makeEntity("Microsoft.Network/networkInterfaces", { name: "nic", subnetId: ref(subnet, "subnet", "id") }));

    const nic = serialize(entities).resources.find((r: any) => r.name === "nic");
    expect(nic.properties.subnetId).toBe("[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'apps')]");
    expect(nic.dependsOn).toEqual(["[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'apps')]"]);
  });

  it("passes a bracket-expression name through unwrapped", () => {
    const sa = makeEntity("Microsoft.Storage/storageAccounts", { name: "[parameters('storageName')]" });
    const entities = new Map<string, any>([["sa", sa]]);
    entities.set("x", makeEntity("Microsoft.Web/sites", { name: "site", blob: ref(sa, "sa", "primaryEndpoints") }));

    const site = serialize(entities).resources.find((r: any) => r.name === "site");
    expect(site.properties.blob).toBe("[reference(resourceId('Microsoft.Storage/storageAccounts', parameters('storageName'))).primaryEndpoints]");
  });
});

describe("azure properties object", () => {
  it("merges an explicit properties object instead of nesting it", () => {
    const entities = new Map<string, any>([["app", makeEntity("Microsoft.App/containerApps", {
      name: "web",
      location: "eastus",
      properties: { configuration: { ingress: { external: true, targetPort: 8080 } } },
    })]]);

    const app = serialize(entities).resources[0];
    expect(app.properties.properties).toBeUndefined();
    expect(app.properties.configuration).toEqual({ ingress: { external: true, targetPort: 8080 } });
  });
});
