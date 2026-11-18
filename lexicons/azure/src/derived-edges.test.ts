/**
 * #5286: derived edges over an azure index, on the listing recorded from
 * floci-az (./testdata/indexed/identity.listing.json: two resource groups, a
 * virtual network with one subnet listed on its own with no location, a
 * storage account in westeurope, and a network security group of one name in
 * each resource group), and on rows built for the cases it lacks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { reconstructIndexedEdges } from "@intentius/chant/graph-refs";
import { deriveEdges, indexedNodeScope } from "@intentius/chant/lifecycle/derive-edges";
import { typeListing, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import type { IndexDocument } from "@intentius/chant/lifecycle/index-document";
import { azureReferenceCatalog, armParentId } from "./reference-catalog";
import { azurePlugin } from "./plugin";

const listing = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "indexed", "identity.listing.json"), "utf-8")) as ListingResult;
const SUB = "/subscriptions/00000000-0000-0000-0000-000000004538";

const short = (id: string) => id.split("/").slice(-2).join("/");

describe("armParentId", () => {
  test("a top-level resource is in its resource group, a child in its parent", () => {
    expect(armParentId(`${SUB}/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v`)).toBe(`${SUB}/resourceGroups/rg`);
    expect(armParentId(`${SUB}/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/s`)).toBe(
      `${SUB}/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v`,
    );
    expect(armParentId(`${SUB}/resourceGroups/rg/providers/Microsoft.Sql/servers/s/databases/d/extensions/e`)).toBe(
      `${SUB}/resourceGroups/rg/providers/Microsoft.Sql/servers/s/databases/d`,
    );
  });

  test("a resource group and a subscription have no parent here", () => {
    expect(armParentId(`${SUB}/resourceGroups/rg`)).toBeUndefined();
    expect(armParentId(SUB)).toBeUndefined();
  });
});

describe("azure derived edges over the floci-az listing", () => {
  const doc: IndexDocument = deriveEdges(typeListing(listing, [azurePlugin]), [azurePlugin]);
  const derived = doc.graph.edges.filter((e) => e.origin === "derived");
  const rows = derived.map((e) => `${short(e.from)} -> ${short(e.to)} [${e.viaAttr}] ${e.relation}`).sort();

  test("every resource is in its resource group and the subnet is in its virtual network", () => {
    const inGroup = derived.filter((e) => e.rule === "azure:*:id");
    const nodes = doc.graph.nodes.filter((n) => n.nativeId && armParentId(n.nativeId) !== undefined);
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      const parent = inGroup.find((e) => e.from === n.id);
      expect(parent, n.nativeId).toBeDefined();
      const to = doc.graph.nodes.find((x) => x.id === parent!.to)!;
      expect(to.nativeId?.toLowerCase()).toBe(armParentId(n.nativeId!)!.toLowerCase());
    }
    expect(rows.some((r) => r.startsWith("subnets/") || r.includes("/subnets/"))).toBe(true);
    expect(rows).toContain("virtualNetworks/ladybug-vnet -> resourceGroups/ladybug-rg [id] containment");
  });

  test("no derived edge joins the two same-named network security groups across resource groups", () => {
    const refs = derived.filter((e) => e.relation === "reference");
    for (const e of refs) {
      const from = doc.graph.nodes.find((n) => n.id === e.from)!;
      const to = doc.graph.nodes.find((n) => n.id === e.to)!;
      const rg = (n: IRNode) => /resourcegroups\/([^/]+)/i.exec(n.nativeId ?? "")?.[1].toLowerCase();
      expect(rg(to), `${from.nativeId} -> ${to.nativeId}`).toBe(rg(from));
    }
  });
});

describe("regionless, case-insensitive ids", () => {
  const catalogs = [{ lexicon: "azure", catalog: azureReferenceCatalog }];
  const mk = (stamp: string, nodes: IRNode[]): IndexDocument =>
    ({ stamp: { scope: { kind: "cloud", substrate: "azure", scopeId: stamp }, scopeKey: `azure/${stamp}` }, graph: { nodes, edges: [] } }) as unknown as IndexDocument;
  const scopeFor = (stamp: string) => (n: IRNode) => indexedNodeScope(mk(stamp, [n]), n, azureReferenceCatalog.indexIds);
  const SUB_A = "/subscriptions/aaaa";
  const SUB_B = "/subscriptions/bbbb";
  const nsg = (sub: string) => `${sub}/resourceGroups/rg/providers/Microsoft.Network/networkSecurityGroups/web`;
  const holder = (sub: string, location: string): IRNode => ({
    id: `h-${location}`,
    kind: "Microsoft.Network/networkInterfaces",
    lexicon: "azure",
    nativeId: `${sub}/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/nic-${location}`,
    location,
    attrs: { networkSecurityGroup: { id: nsg(sub) } },
  });
  const target = (sub: string, id: string, location?: string): IRNode => ({
    id,
    kind: "Microsoft.Network/networkSecurityGroups",
    lexicon: "azure",
    nativeId: nsg(sub),
    ...(location ? { location } : {}),
    attrs: {},
  });

  test("a row with no location joins from a holder in any region of its subscription", () => {
    for (const region of ["eastus", "westeurope", "japaneast"]) {
      const out = reconstructIndexedEdges([holder(SUB_A, region), target(SUB_A, "nsg")], catalogs, scopeFor("aaaa"));
      expect(out.edges.filter((e) => e.relation === "reference").map((e) => `${e.from} -> ${e.to}`)).toEqual([`h-${region} -> nsg`]);
    }
  });

  test("and a row with no location, as the holder, reaches a target in any region", () => {
    const h: IRNode = { ...holder(SUB_A, "eastus"), id: "h-none" };
    delete h.location;
    const out = reconstructIndexedEdges([h, target(SUB_A, "nsg", "westeurope")], catalogs, scopeFor("aaaa"));
    expect(out.edges.map((e) => `${e.from} -> ${e.to}`)).toContain("h-none -> nsg");
  });

  test("it does not join from a holder of another subscription", () => {
    const nodes = [holder(SUB_A, "eastus"), target(SUB_B, "nsg-b")];
    const out = reconstructIndexedEdges(nodes, catalogs, (n) => scopeFor(n.id === "nsg-b" ? "bbbb" : "aaaa")(n));
    expect(out.edges).toEqual([]);
    expect(out.dangling.map((d) => d.value)).toEqual([nsg(SUB_A)]);
  });

  test("two ids that differ only in casing join", () => {
    const h = holder(SUB_A, "eastus");
    (h.attrs.networkSecurityGroup as { id: string }).id = nsg(SUB_A).replace("resourceGroups", "resourcegroups").replace("Microsoft.Network", "microsoft.network").toUpperCase();
    const out = reconstructIndexedEdges([h, target(SUB_A, "nsg", "eastus")], catalogs, scopeFor("aaaa"));
    expect(out.edges.filter((e) => e.relation === "reference").map((e) => `${e.from} -> ${e.to}`)).toEqual(["h-eastus -> nsg"]);
    expect(out.dangling).toEqual([]);
  });

  test("a parent in the id joins whatever its casing, and a parent not listed draws nothing", () => {
    const rg: IRNode = { id: "rg", kind: "Microsoft.Resources/resourceGroups", lexicon: "azure", nativeId: `${SUB_A}/resourcegroups/RG`, attrs: {} };
    const nic = holder(SUB_A, "eastus");
    const out = reconstructIndexedEdges([rg, nic], catalogs, scopeFor("aaaa"));
    expect(out.containment).toContainEqual({ child: "h-eastus", parent: "rg", label: "in" });
    const alone = reconstructIndexedEdges([nic], catalogs, scopeFor("aaaa"));
    expect(alone.containment).toEqual([]);
    expect(alone.dangling.filter((d) => d.rule === "azure:*:id")).toEqual([]);
  });
});
