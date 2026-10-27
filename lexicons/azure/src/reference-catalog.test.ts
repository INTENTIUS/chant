/**
 * #4535: the azure reference catalog. Each rule draws its edge on a fixture
 * of its own, the catalog keeps behold#1023's ruling (typed rules, no edge on
 * ambiguity, scoped join keys), and a Container Apps site in Resource Graph's
 * shape (the resources example-three-cloud's azure member declares) gets its
 * topology.
 */
import { describe, expect, it } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { reconstructIndexedEdges, refRuleId, type ReferenceCatalog } from "@intentius/chant/graph-refs";
import { azureReferenceCatalog } from "./reference-catalog";
import { azureObservedTree } from "./listed-types";
import { azurePlugin } from "./plugin";

const LEXICON = "azure";
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000001";
const RG = `${SUB}/resourceGroups/local`;

/** attrs with `value` written at a catalog path (`a.b`, `arr[].c`). */
function atPath(path: string, value: string): Record<string, unknown> {
  const parts = path.split(".");
  const build = (i: number): unknown => {
    if (i === parts.length) return value;
    const part = parts[i];
    const isArr = part.endsWith("[]");
    const inner = build(i + 1);
    return { [isArr ? part.slice(0, -2) : part]: isArr ? [inner] : inner };
  };
  return build(0) as Record<string, unknown>;
}

/** A node of `kind` named `value`: by its native id (an ARM id), or by the identity path a non-id reference reads. */
function target(catalog: ReferenceCatalog, kind: string, id: string, value: string, byIdentity: boolean): IRNode {
  const path = catalog.identities.find((r) => r.kind === kind)?.ids[0];
  return byIdentity && path ? { id, kind, lexicon: LEXICON, attrs: atPath(path, value) } : { id, kind, lexicon: LEXICON, attrs: {}, nativeId: value };
}

/** A Resource Graph row as a node: flattened as ./listed-types.ts flattens it, named by its `id`. */
function row(kind: string, id: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}): IRNode {
  return { id, kind, lexicon: LEXICON, nativeId: id, location: "westeurope", attrs: azureObservedTree({ name: id.split("/").pop(), location: "westeurope", properties, ...extra }) };
}

const scope = (n: IRNode) => ({ account: `azure${SUB}`, ...(n.location ? { region: n.location } : {}) });

describe("azure reference catalog", () => {
  it("is the plugin's referenceCatalog", () => {
    expect(azurePlugin.referenceCatalog).toBe(azureReferenceCatalog);
  });

  it("names a target kind on every rule (behold#1023's ruling)", () => {
    expect(azureReferenceCatalog.refs.filter((r) => !(r.targetKind ?? r.indexedTargetKind))).toEqual([]);
  });

  it("has no two rules for one holder kind, path and target kind", () => {
    const keys = azureReferenceCatalog.refs.map((r) => `${r.from}|${r.path}|${r.targetKind}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  describe("each rule draws its edge", () => {
    for (const [i, rule] of azureReferenceCatalog.refs.entries()) {
      const to = rule.targetKind ?? rule.indexedTargetKind!;
      it(`${rule.from} ${rule.path} -> ${to}`, () => {
        // An `.id` or `*Id` path holds an ARM id; anything else (a customer
        // id, an identity's id in a registry entry) names the target by a
        // value its identity rule lists.
        const byId = /(^|\.)(id|[A-Za-z]+Id|[A-Za-z]+ID)$/.test(rule.path) || rule.path.endsWith("[].id");
        const value = byId ? `${RG}/providers/${to.replace("_", "/")}/target-${i}` : `value-${i}`;
        const holder: IRNode = { id: `holder-${i}`, kind: rule.from, lexicon: LEXICON, attrs: atPath(rule.path, value) };
        const nodes = [holder, target(azureReferenceCatalog, to, `target-${i}`, value, !byId)];
        const out = reconstructIndexedEdges(nodes, [{ lexicon: LEXICON, catalog: azureReferenceCatalog }], () => ({ account: "azure/sub" }));
        const edge = out.edges.find((e) => e.from === holder.id && e.to === `target-${i}`);
        expect(edge?.rule).toBe(refRuleId(LEXICON, rule.from, rule.path));
        expect(edge?.relation).toBe(rule.relation);
      });
    }
  });

  describe("a Container Apps site in Resource Graph's shape", () => {
    const vnet = `${RG}/providers/Microsoft.Network/virtualNetworks/three-cloud-vnet`;
    const subnet = `${vnet}/subnets/apps`;
    const logs = `${RG}/providers/Microsoft.OperationalInsights/workspaces/three-cloud-logs`;
    const identity = `${RG}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/three-cloud-web`;
    const env = `${RG}/providers/Microsoft.App/managedEnvironments/three-cloud`;
    const app = `${RG}/providers/Microsoft.App/containerApps/web`;
    const nodes: IRNode[] = [
      row("Microsoft.Network/virtualNetworks", vnet, { addressSpace: { addressPrefixes: ["10.40.0.0/16"] }, subnets: [{ id: subnet, name: "apps", properties: { addressPrefix: "10.40.0.0/23" } }] }),
      row("Microsoft.Network/virtualNetworks_subnets", subnet, { addressPrefix: "10.40.0.0/23" }),
      row("Microsoft.OperationalInsights/workspaces", logs, { customerId: "6f1c2b3a-0000-4000-8000-000000000001", retentionInDays: 30 }),
      row("Microsoft.ManagedIdentity/userAssignedIdentities", identity, {}),
      row("Microsoft.App/managedEnvironments", env, {
        vnetConfiguration: { infrastructureSubnetId: subnet },
        appLogsConfiguration: { destination: "log-analytics", logAnalyticsConfiguration: { customerId: "6f1c2b3a-0000-4000-8000-000000000001" } },
      }),
      row(
        "Microsoft.App/containerApps",
        app,
        { managedEnvironmentId: env, environmentId: env, configuration: { ingress: { fqdn: "web.three-cloud.westeurope.azurecontainerapps.io", external: true } } },
        { identity: { type: "UserAssigned", userAssignedIdentities: { [identity]: {} } } },
      ),
    ];
    const out = reconstructIndexedEdges(nodes, [{ lexicon: LEXICON, catalog: azureReferenceCatalog }], scope);
    const short = (s: string) => s.split("/").slice(-2).join("/");

    it("draws the environment's subnet and workspace and the app's environment", () => {
      expect(out.edges.map((e) => `${short(e.from)} -> ${short(e.to)} [${e.viaAttr}] ${e.relation}`)).toEqual([
        "containerApps/web -> managedEnvironments/three-cloud [environmentId] containment",
        "containerApps/web -> managedEnvironments/three-cloud [managedEnvironmentId] containment",
        "managedEnvironments/three-cloud -> subnets/apps [vnetConfiguration] containment",
        "managedEnvironments/three-cloud -> workspaces/three-cloud-logs [appLogsConfiguration] reference",
      ]);
      expect(out.containment.map((c) => `${short(c.child)} in ${short(c.parent)}`)).toEqual([
        "containerApps/web in managedEnvironments/three-cloud",
        "managedEnvironments/three-cloud in subnets/apps",
      ]);
    });

    it("leaves the identity, named in an object key, without an edge rather than guessing", () => {
      expect(out.edges.some((e) => e.to === identity)).toBe(false);
      expect(out.dangling).toEqual([]);
    });
  });

  it("does not join a reference to the same id in another subscription", () => {
    const subnet = `${RG}/providers/Microsoft.Network/virtualNetworks/v/subnets/apps`;
    const nodes: IRNode[] = [
      { ...row("Microsoft.App/managedEnvironments", "env", { vnetConfiguration: { infrastructureSubnetId: subnet } }) },
      { ...row("Microsoft.Network/virtualNetworks_subnets", subnet, {}), id: "other-sub-subnet" },
    ];
    const out = reconstructIndexedEdges(nodes, [{ lexicon: LEXICON, catalog: azureReferenceCatalog }], (n) => ({ account: n.id === "env" ? "azure/sub-a" : "azure/sub-b", region: "westeurope" }));
    expect(out.edges).toEqual([]);
    expect(out.dangling.map((d) => d.value)).toEqual([subnet]);
  });

  it("draws no edge when a customer id names two workspaces, and records both", () => {
    const nodes: IRNode[] = [
      row("Microsoft.App/managedEnvironments", "env", { appLogsConfiguration: { logAnalyticsConfiguration: { customerId: "c-1" } } }),
      row("Microsoft.OperationalInsights/workspaces", "ws-a", { customerId: "c-1" }),
      row("Microsoft.OperationalInsights/workspaces", "ws-b", { customerId: "c-1" }),
    ];
    const out = reconstructIndexedEdges(nodes, [{ lexicon: LEXICON, catalog: azureReferenceCatalog }], scope);
    expect(out.edges).toEqual([]);
    expect(out.ambiguous.map((a) => a.candidates)).toEqual([["ws-a", "ws-b"]]);
  });
});
