import { describe, expect, test } from "vitest";
import { armResourcePath, armType } from "./arm-type";
import { azureSerializer } from "./serializer";
import { armResourceReadUrl } from "./api/read-client";
import { armResourceUrl, evalArmString, type ArmEvalCtx } from "./op/activities/az-apply";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { AttrRef } from "@intentius/chant";

describe("ARM child types (#4230)", () => {
  test("armType joins child types with /", () => {
    expect(armType("Microsoft.Network/virtualNetworks_subnets")).toBe("Microsoft.Network/virtualNetworks/subnets");
    expect(armType("Microsoft.Storage/storageAccounts_blobServices_containers")).toBe("Microsoft.Storage/storageAccounts/blobServices/containers");
    expect(armType("Microsoft.Storage/storageAccounts")).toBe("Microsoft.Storage/storageAccounts");
    expect(armType("Microsoft.Network/virtualNetworks/subnets")).toBe("Microsoft.Network/virtualNetworks/subnets");
  });

  test("armResourcePath interleaves type and name segments", () => {
    expect(armResourcePath("Microsoft.Network/virtualNetworks_subnets", "vnet/apps")).toBe("Microsoft.Network/virtualNetworks/vnet/subnets/apps");
    expect(armResourcePath("Microsoft.Storage/storageAccounts", "st1")).toBe("Microsoft.Storage/storageAccounts/st1");
  });

  test("a Subnet serializes type, resourceId and dependsOn with /", () => {
    const entity = (entityType: string, props: Record<string, unknown>): Declarable =>
      ({ [DECLARABLE_MARKER]: true, lexicon: "azure", entityType, kind: "resource", props }) as unknown as Declarable;
    const subnet = entity("Microsoft.Network/virtualNetworks_subnets", { name: "vnet/apps", addressPrefix: "10.0.1.0/24" });
    const subnetId = new AttrRef(subnet, "id");
    subnetId._setLogicalName("apps");
    const nic = entity("Microsoft.Network/networkInterfaces", { name: "nic1", subnetId });
    const entities = new Map<string, Declarable>([["apps", subnet], ["nic", nic]]);
    const template = JSON.parse(azureSerializer.serialize(entities) as string);
    const [s, n] = template.resources;
    expect(s.type).toBe("Microsoft.Network/virtualNetworks/subnets");
    expect(JSON.stringify(template)).not.toContain("virtualNetworks_subnets");
    expect(n.properties.subnetId).toBe("[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'apps')]");
    expect(n.dependsOn).toContain("[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'apps')]");
  });

  test("apply and read address a child resource by its ARM path", async () => {
    const ctx = { base: "http://x", subscriptionId: "sub-1", resourceGroup: "rg", location: "eastus", deployed: new Map() } as unknown as ArmEvalCtx;
    const want = "http://x/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/apps?api-version=2024-01-01";
    expect(await armResourceUrl({ type: "Microsoft.Network/virtualNetworks/subnets", apiVersion: "2024-01-01", name: "vnet/apps" }, ctx)).toBe(want);
    expect(armResourceReadUrl({ endpoint: "http://x", subscriptionId: "sub-1", resourceGroup: "rg" }, "Microsoft.Network/virtualNetworks_subnets", "vnet/apps", "2024-01-01")).toBe(want);
    expect(await evalArmString("[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet', 'apps')]", ctx)).toBe(
      "/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/apps",
    );
  });
});
