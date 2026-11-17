/**
 * #4538 on the azure lexicon: the index match and `chant search --index`'s
 * join over a listing recorded from floci-az
 * (./testdata/indexed/identity.listing.json, core's lister against a
 * subscription seeded with two resource groups, a virtual network with one
 * subnet, a storage account in westeurope, and a network security group of
 * one name in each resource group).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { GraphIR, IRNode } from "@intentius/chant/graph-ir";
import { joinDeclaredToIndex } from "@intentius/chant/lifecycle/index-join";
import { typeListing, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { azureDeclaredIdentity, azureNodeIdentities, azureNodeKey, normalizeAzureLocation } from "./index-identity";
import { azurePlugin } from "./plugin";

const listing = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "indexed", "identity.listing.json"), "utf-8")) as ListingResult;
const doc = typeListing(listing, [azurePlugin]);
const SUB = "/subscriptions/00000000-0000-0000-0000-000000004538";
const RG = `${SUB}/resourceGroups/ladybug-rg`;

const node = (name: string, kind: string, attrs: Record<string, unknown>): IRNode => ({ id: `app::${name}`, kind, lexicon: "azure", attrs });

describe("azureDeclaredIdentity", () => {
  test("the identifier is the provider-relative path ARM builds from the type and name, lowercased", () => {
    expect(azureDeclaredIdentity("Microsoft.Network/virtualNetworks", { name: "Vnet", location: "eastus" }, null)).toEqual({
      kind: "identifier",
      listedType: "microsoft.network/virtualnetworks",
      identifier: "microsoft.network/virtualnetworks/vnet",
      global: false,
      location: "eastus",
    });
    expect(azureDeclaredIdentity("Microsoft.Network/virtualNetworks_subnets", { name: "vnet/apps" }, null)).toMatchObject({
      listedType: "microsoft.network/virtualnetworks/subnets",
      identifier: "microsoft.network/virtualnetworks/vnet/subnets/apps",
      location: "*",
    });
  });

  test("ARM's display spelling of a location is the listed one", () => {
    expect(normalizeAzureLocation("East US")).toBe("eastus");
    expect(azureDeclaredIdentity("Microsoft.Storage/storageAccounts", { name: "sa", location: "West Europe" }, null)).toMatchObject({ location: "westeurope" });
  });

  test("a location left to the resource group, as an expression or not at all, is looked for everywhere", () => {
    expect(azureDeclaredIdentity("Microsoft.Storage/storageAccounts", { name: "sa", location: "[resourceGroup().location]" }, null)).toMatchObject({ location: "*" });
    expect(azureDeclaredIdentity("Microsoft.Storage/storageAccounts", { name: "sa", location: { fn: "x" } }, null)).toMatchObject({ location: "*" });
  });

  test("a name the declaration does not spell is no-binding", () => {
    expect(azureDeclaredIdentity("Microsoft.Storage/storageAccounts", {}, null)).toMatchObject({ kind: "unmatchable", reason: "no-binding" });
    expect(azureDeclaredIdentity("Microsoft.Storage/storageAccounts", { name: "[concat('a', uniqueString(resourceGroup().id))]" }, null)).toMatchObject({
      kind: "unmatchable",
      reason: "no-binding",
    });
    expect(azureDeclaredIdentity("Microsoft.Storage/storageAccounts", { name: { fn: "Concat" } }, null)).toMatchObject({ reason: "no-binding" });
  });

  test("a kind the registry does not hold is unsupported-kind", () => {
    expect(azureDeclaredIdentity("Microsoft.Nope/things", { name: "x" }, new Set(["Microsoft.Storage/storageAccounts"]))).toMatchObject({
      kind: "unmatchable",
      reason: "unsupported-kind",
    });
    expect(azureDeclaredIdentity("Azure::Parameter", { name: "x" }, null)).toMatchObject({ reason: "unsupported-kind" });
  });
});

describe("node keys and identities", () => {
  test("the key is the id after its last /providers/, lowercased; a resource group has none", () => {
    expect(azureNodeKey({ nativeId: `${RG}/providers/Microsoft.Network/virtualNetworks/ladybug-vnet/subnets/apps` })).toBe(
      "microsoft.network/virtualnetworks/ladybug-vnet/subnets/apps",
    );
    expect(azureNodeKey({ nativeId: RG })).toBeUndefined();
  });

  test("a resource answers to its ARM id as listed and lowercased", () => {
    const vnet = doc.graph.nodes.find((n) => n.nativeId === `${RG}/providers/Microsoft.Network/virtualNetworks/ladybug-vnet`)!;
    expect(azureNodeIdentities(vnet).map((v) => v.value)).toEqual([vnet.nativeId, vnet.nativeId!.toLowerCase()]);
  });
});

describe("search --index's join on the floci-az listing", () => {
  const declared: GraphIR = {
    version: 1,
    nodes: [
      node("vnet", "Microsoft.Network/virtualNetworks", { name: "ladybug-vnet", location: "eastus", properties: { addressSpace: { addressPrefixes: ["10.0.0.0/16"] } } }),
      node("subnet", "Microsoft.Network/virtualNetworks_subnets", { name: "ladybug-vnet/apps", properties: { addressPrefix: "10.0.1.0/24" } }),
      node("store", "Microsoft.Storage/storageAccounts", { name: "LADYBUG4538SA", location: "[resourceGroup().location]", kind: "StorageV2" }),
      node("store-east", "Microsoft.Storage/storageAccounts", { name: "ladybug4538sa", location: "eastus" }),
      node("logs", "Microsoft.Storage/storageAccounts", { name: "ladybug4538logs", location: "westeurope" }),
      node("nsg", "Microsoft.Network/networkSecurityGroups", { name: "ladybug-nsg", location: "eastus" }),
      node("vault", "Microsoft.KeyVault/vaults", { name: "[parameters('vaultName')]", location: "eastus" }),
    ],
    edges: [],
    groups: { byLexicon: {} },
  };
  const { ir, joins } = joinDeclaredToIndex(declared, doc, [azurePlugin]);
  const row = (name: string) => ir.nodes.find((n) => n.id === `app::${name}`)!;

  test("the vnet, its subnet and the storage account are bound, across casing and resource groups", () => {
    expect(joins["app::vnet"]).toMatchObject({ verdict: "bound", nativeId: `${RG}/providers/Microsoft.Network/virtualNetworks/ladybug-vnet`, location: "eastus" });
    expect(joins["app::subnet"]).toMatchObject({ verdict: "bound", nativeId: `${RG}/providers/Microsoft.Network/virtualNetworks/ladybug-vnet/subnets/apps`, location: "global" });
    expect(joins["app::store"]).toMatchObject({ verdict: "bound", nativeId: `${RG}/providers/Microsoft.Storage/storageAccounts/ladybug4538sa`, location: "westeurope" });
    expect(row("store").physicalId).toBe(`${RG}/providers/Microsoft.Storage/storageAccounts/ladybug4538sa`);
  });

  test("a name the index holds at another location, or not at all, is absent", () => {
    expect(joins["app::store-east"]).toMatchObject({ verdict: "absent", location: "eastus" });
    expect(joins["app::logs"]).toMatchObject({ verdict: "absent", identifier: "microsoft.storage/storageaccounts/ladybug4538logs" });
  });

  test("one name in two resource groups is refused: the declaration does not say which", () => {
    expect(joins["app::nsg"]).toMatchObject({ verdict: "ambiguous" });
    expect((joins["app::nsg"] as { candidates: string[] }).candidates).toHaveLength(2);
    expect(row("nsg").physicalId).toBeUndefined();
  });

  test("a name spelled with an ARM expression is no-binding", () => {
    expect(joins["app::vault"]).toMatchObject({ verdict: "no-binding" });
  });
});
