/**
 * #5264 on the azure lexicon: `chant import --index` over a Resource Graph
 * listing, typed (#4521) and its edges derived as `chant index azure` writes
 * it, then imported through the azure seam and ArmGenerator, and built.
 *
 * The rows are the shapes floci-az's Resource Graph returned for a resource
 * group, a virtual network with an inline subnet, the subnet's own row and a
 * storage account, plus a Key Vault and a SQL server whose administrator
 * password the index masks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { MASKED } from "@intentius/chant/deep-observation";
import { deriveEdges } from "@intentius/chant/lifecycle/derive-edges";
import type { IndexDocument } from "@intentius/chant/lifecycle/index-document";
import { declaredNodes, planIndexImport } from "@intentius/chant/lifecycle/index-import";
import { typeListing, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { renderIndexImport } from "@intentius/chant/cli/commands/import-index";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { azureDeclaredName, azureImportProperties } from "./index-import";
import { azureNodeKey } from "./index-identity";
import { azureKindForListedType, azureListedTypeForKind } from "./listed-types";
import { azurePlugin } from "./plugin";
import { azureSerializer } from "./serializer";
import { Parameter } from "./parameter";

const SUB = "00000000-0000-0000-0000-000000005264";
const RG = `/subscriptions/${SUB}/resourceGroups/ladybug-rg`;
const VNET = `${RG}/providers/Microsoft.Network/virtualNetworks/ladybug-vnet`;
const SUBNET = `${VNET}/subnets/apps`;
const SA = `${RG}/providers/Microsoft.Storage/storageAccounts/ladybug5264sa`;
const KV = `${RG}/providers/Microsoft.KeyVault/vaults/ladybug-kv`;
const SQL = `${RG}/providers/Microsoft.Sql/servers/ladybug-sql`;
const TENANT = "11111111-1111-1111-1111-111111111111";

/** A Resource Graph row as core's lister writes it: tags beside, every other column under properties. */
function row(listedType: string, id: string, location: string, extra: Record<string, unknown>, tags: Record<string, string> = {}) {
  const name = id.slice(id.lastIndexOf("/") + 1);
  return {
    listedType,
    location: location || "global",
    nativeId: id,
    cloudIds: [
      { kind: "provider-id", value: id },
      { kind: "provider-id", value: id.toLowerCase() },
    ],
    tags,
    properties: { id, name, type: listedType, location, kind: "", identity: null, sku: null, plan: null, zones: null, ...extra },
    observedAt: "2026-11-17T20:47:58.000Z",
  };
}

const listing = {
  listing: "v1",
  source: { name: "chant-lister", version: "0.0.0-fixture" },
  scope: { substrate: "azure", scopeId: SUB, locations: "*", types: "*" },
  startedAt: "2026-11-17T20:47:57.000Z",
  completedAt: "2026-11-17T20:47:58.000Z",
  coverage: [{ listedType: "*", location: "*", verdict: "listed" }],
  notes: [],
  resources: [
    row("microsoft.resources/subscriptions/resourcegroups", RG, "westeurope", { managedBy: "", properties: { provisioningState: "Succeeded" } }, { team: "graph", "chant-managed-by": "chant" }),
    row("microsoft.network/virtualnetworks", VNET, "westeurope", {
      properties: {
        provisioningState: "Succeeded",
        addressSpace: { addressPrefixes: ["10.40.0.0/16"] },
        subnets: [{ name: "apps", id: SUBNET, properties: { addressPrefix: "10.40.1.0/24", provisioningState: "Succeeded" } }],
      },
    }),
    row("microsoft.network/virtualnetworks/subnets", SUBNET, "", { properties: { addressPrefix: "10.40.1.0/24", provisioningState: "Succeeded" } }),
    row("microsoft.storage/storageaccounts", SA, "westeurope", {
      kind: "StorageV2",
      sku: { name: "Standard_LRS", tier: "Standard" },
      properties: {
        provisioningState: "Succeeded",
        primaryEndpoints: { blob: "http://ladybug5264sa.blob.core.windows.net/" },
        primaryLocation: "westeurope",
        statusOfPrimary: "available",
        minimumTlsVersion: "TLS1_2",
        allowBlobPublicAccess: false,
      },
    }),
    row("microsoft.keyvault/vaults", KV, "westeurope", {
      properties: { tenantId: TENANT, vaultUri: "https://ladybug-kv.vault.azure.net/", provisioningState: "Succeeded", enableRbacAuthorization: true },
    }),
    row("microsoft.sql/servers", SQL, "westeurope", {
      properties: { administratorLogin: "sqladmin", administratorLoginPassword: "hunter2", version: "12.0", fullyQualifiedDomainName: "ladybug-sql.database.windows.net" },
    }),
  ],
} as unknown as ListingResult;

const listingLexicon: ListingLexicon = {
  name: azurePlugin.name,
  deepNormalizationHooks: azurePlugin.deepNormalizationHooks,
  listedTypes: azurePlugin.listedTypes,
};
const doc: IndexDocument = deriveEdges(typeListing(listing, [listingLexicon]), [
  { name: "azure", referenceCatalog: azurePlugin.referenceCatalog, indexIdentity: azurePlugin.indexIdentity },
]);
const plugin = azurePlugin as LexiconPlugin;
const nodeOf = (id: string) => doc.graph.nodes.find((n) => n.nativeId === id)!;

function importOf(nativeIds: string[], declared?: ReadonlyMap<string, string>) {
  const nodes = nativeIds.map((id) => nodeOf(id).id);
  const plan = planIndexImport([doc], { nodes }, [plugin], declared ? { declared } : {});
  const { files, warnings } = renderIndexImport(plan, [plugin]);
  return { plan, files, warnings };
}

/** Build the files of one output group and return the ARM template. */
async function synth(files: Array<{ path: string; content: string }>, dir: string): Promise<{ template: Record<string, any>; entities: Map<string, any> }> {
  const tmp = mkdtempSync(join(import.meta.dirname, "../.index-import-tmp-"));
  try {
    const src = join(tmp, "src");
    mkdirSync(src);
    const prefix = dir ? `${dir}/` : "";
    for (const f of files.filter((x) => x.path.startsWith(prefix))) writeFileSync(join(src, f.path.slice(prefix.length)), f.content);
    const result = await build(src, [azureSerializer]);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    return { template: JSON.parse(result.outputs.get("azure") as string), entities: result.entities };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("azure listed types and identity for resource groups", () => {
  test("a resource group maps both ways and keys by its name", () => {
    expect(azureListedTypeForKind("Microsoft.Resources/resourceGroups")).toBe("microsoft.resources/subscriptions/resourcegroups");
    expect(azureKindForListedType("microsoft.resources/subscriptions/resourcegroups")).toBe("Microsoft.Resources/resourceGroups");
    expect(azureNodeKey({ nativeId: RG })).toBe("microsoft.resources/resourcegroups/ladybug-rg");
  });

  test("a declared name is rebuilt from the ARM id", () => {
    expect(azureDeclaredName("Microsoft.Network/virtualNetworks_subnets", SUBNET)).toBe("ladybug-vnet/apps");
    expect(azureDeclaredName("Microsoft.Network/virtualNetworks", VNET)).toBe("ladybug-vnet");
    expect(azureDeclaredName("Microsoft.Resources/resourceGroups", RG)).toBe("ladybug-rg");
  });
});

describe("chant import --index on an azure listing", () => {
  test("a storage account keeps declarable names only, under properties", () => {
    const { properties, missing } = azureImportProperties(nodeOf(SA));
    expect(properties).toEqual({
      kind: "StorageV2",
      location: "westeurope",
      name: "ladybug5264sa",
      sku: { name: "Standard_LRS", tier: "Standard" },
      properties: { allowBlobPublicAccess: false, minimumTlsVersion: "TLS1_2" },
    });
    expect(missing).toEqual([]);
  });

  test("a Key Vault keeps its required tenantId through the index, and a missing sku becomes a parameter", () => {
    expect(nodeOf(KV).attrs?.tenantId).toBe(TENANT);
    const { properties, missing } = azureImportProperties(nodeOf(KV));
    expect(properties.properties).toEqual({ enableRbacAuthorization: true, tenantId: TENANT });
    expect(missing).toEqual(["properties.sku"]);
  });

  test("resource group, virtual network, subnet and storage account: import, then build each group", async () => {
    const { plan, files } = importOf([RG, VNET, SUBNET, SA]);
    expect(plan.report.resources.every((r) => r.status === "imported")).toBe(true);
    expect(files.map((f) => f.path).sort()).toEqual(["azure/westeurope/rg-ladybug-rg/main.ts", "azure/westeurope/subscription/main.ts"]);

    const rgFile = files.find((f) => f.path.includes("rg-ladybug-rg"))!.content;
    expect(rgFile).toContain("new Subnet({");
    expect(rgFile).not.toContain("Unknown resource type");
    expect(rgFile).not.toContain("statusOfPrimary");
    expect(rgFile).not.toContain("primaryEndpoints");

    const subFile = files.find((f) => f.path.includes("subscription"))!.content;
    expect(subFile).toContain("deploys at subscription scope");
    expect(subFile).not.toContain("chant-managed-by");

    const { template: rgTemplate, entities: rgEntities } = await synth(files, "azure/westeurope/rg-ladybug-rg");
    expect(rgTemplate.$schema).toContain("/deploymentTemplate.json");
    const byType = Object.fromEntries(rgTemplate.resources.map((r: any) => [r.type, r]));
    expect(byType["Microsoft.Network/virtualNetworks/subnets"].name).toBe("ladybug-vnet/apps");
    expect(byType["Microsoft.Network/virtualNetworks/subnets"].dependsOn).toEqual(["[resourceId('Microsoft.Network/virtualNetworks', 'ladybug-vnet')]"]);
    expect(byType["Microsoft.Network/virtualNetworks"].properties.subnets).toEqual([{ name: "apps", properties: { addressPrefix: "10.40.1.0/24" } }]);
    expect(byType["Microsoft.Storage/storageAccounts"].properties).toEqual({ allowBlobPublicAccess: false, minimumTlsVersion: "TLS1_2" });

    const { template: subTemplate, entities: subEntities } = await synth(files, "azure/westeurope/subscription");
    expect(subTemplate.$schema).toContain("/subscriptionDeploymentTemplate.json");
    expect(subTemplate.resources).toEqual([
      { apiVersion: expect.any(String), location: "westeurope", name: "ladybug-rg", tags: { team: "graph" }, type: "Microsoft.Resources/resourceGroups" },
    ]);

    // A second import reads them as declared.
    const declaredEntities = new Map([
      [
        "azure",
        [...rgEntities, ...subEntities].map(([name, e]) => ({ name, entityType: e.entityType, props: e.props as Record<string, unknown> })),
      ],
    ]);
    const declared = declaredNodes([doc], declaredEntities, [plugin]);
    const again = importOf([RG, VNET, SUBNET, SA], declared);
    expect(again.plan.report.resources.map((r) => r.status)).toEqual(["declared", "declared", "declared", "declared"]);
  });

  test("a masked value is written as a securestring parameter, never as a value", async () => {
    expect(JSON.stringify(nodeOf(SQL).attrs)).toContain(MASKED);
    const { plan, files } = importOf([SQL]);
    expect(plan.report.parameters).toEqual([
      expect.objectContaining({ name: "ServerLadybugSqlPropertiesAdministratorLoginPassword", path: "properties.administratorLoginPassword", cause: "masked" }),
    ]);
    const source = files[0].content;
    expect(source).toContain(`export const serverLadybugSqlPropertiesAdministratorLoginPassword = new Parameter("securestring"`);
    expect(source).toContain(`administratorLoginPassword: "[parameters('serverLadybugSqlPropertiesAdministratorLoginPassword')]"`);
    expect(source).not.toContain("hunter2");
    expect(source).not.toContain(MASKED);

    const { template } = await synth(files, "");
    expect(template.parameters).toEqual({
      serverLadybugSqlPropertiesAdministratorLoginPassword: { type: "securestring", metadata: { description: expect.any(String) } },
    });
    expect(template.resources[0].properties.administratorLoginPassword).toBe("[parameters('serverLadybugSqlPropertiesAdministratorLoginPassword')]");
    expect(JSON.stringify(template)).not.toContain(MASKED);
  });

  test("a parameter keeps ARM's own type names", () => {
    const out = azureSerializer.serialize(new Map([["secret", new Parameter("securestring")], ["n", new Parameter("Number")]])) as string;
    expect(JSON.parse(out).parameters).toEqual({ secret: { type: "securestring" }, n: { type: "int" } });
  });
});
