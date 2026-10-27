/**
 * #4521 on the azure lexicon: Resource Graph's lowercase type names mapped to
 * kinds, and a fixture listing typed into nodes through the azure hooks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { typeListing, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { MASKED } from "@intentius/chant/deep-observation";
import { azureKindForListedType, azureListedTypeForKind, azureListedTypeIndex } from "./listed-types";
import { azurePlugin } from "./plugin";

const here = import.meta.dirname;
const surface = JSON.parse(readFileSync(join(here, "..", "surface.snapshot.json"), "utf-8")) as {
  entries: Record<string, { kind: string; resourceType: string }>;
};
// A kind is a resource type; the surface can name one type under two exports
// (AppService and WebApp are both Microsoft.Web/sites), so the kinds are a set.
const KINDS = [...new Set(Object.values(surface.entries).filter((e) => e.kind === "resource").map((e) => e.resourceType))];
const INDEX = azureListedTypeIndex(KINDS);
const listing = JSON.parse(readFileSync(join(here, "testdata", "indexed", "listing.json"), "utf-8")) as ListingResult;

const azure: ListingLexicon = {
  name: azurePlugin.name,
  deepNormalizationHooks: azurePlugin.deepNormalizationHooks,
  listedTypes: { ...azurePlugin.listedTypes!, kindFor: (t) => azureKindForListedType(t, INDEX) },
};

describe("Resource Graph types to azure kinds", () => {
  it("every azure resource kind has a lowercase ARM type that maps back to it, and no two kinds share one", () => {
    const missing = KINDS.filter((k) => azureKindForListedType(azureListedTypeForKind(k), INDEX) !== k);
    expect(missing).toEqual([]);
    expect(INDEX.size).toBe(KINDS.length);
  });

  it("child types join with / as ARM spells them, in any case", () => {
    expect(azureListedTypeForKind("Microsoft.Network/virtualNetworks_subnets")).toBe("microsoft.network/virtualnetworks/subnets");
    expect(azureKindForListedType("microsoft.storage/storageaccounts", INDEX)).toBe("Microsoft.Storage/storageAccounts");
    expect(azureKindForListedType("Microsoft.Storage/storageAccounts", INDEX)).toBe("Microsoft.Storage/storageAccounts");
    expect(azureKindForListedType("microsoft.contoso/widgets", INDEX)).toBeUndefined();
  });
});

describe("the azure fixture listing as typed nodes", () => {
  const doc = typeListing(listing, [azure]);

  it("produces typed nodes, and keeps the unmapped type as an unknown-kind node", () => {
    expect(doc.graph.nodes.map((n) => [n.listedType, n.kind, n.lexicon, n.unmappedKind ?? false])).toEqual([
      ["microsoft.contoso/widgets", "microsoft.contoso/widgets", "azure", true],
      ["microsoft.network/virtualnetworks/subnets", "Microsoft.Network/virtualNetworks_subnets", "azure", false],
      ["microsoft.storage/storageaccounts", "Microsoft.Storage/storageAccounts", "azure", false],
    ]);
  });

  it("flattens properties as the deep reader does, and prunes what the azure hooks prune", () => {
    const st = doc.graph.nodes.find((n) => n.listedType === "microsoft.storage/storageaccounts")!;
    expect(st.attrs.minimumTlsVersion).toBe("TLS1_2");
    expect(st.attrs.sku).toEqual({ name: "Standard_LRS", tier: "Standard" });
    expect(st.attrs.properties).toBeUndefined();
    expect(st.attrs.id).toBeUndefined();
    expect(st.attrs.provisioningState).toBeUndefined();
  });

  it("masks a secret on an unmapped node too", () => {
    const w = doc.graph.nodes.find((n) => n.unmappedKind)!;
    expect((w.attrs.properties as Record<string, unknown>).connectionString).toBe(MASKED);
  });
});
