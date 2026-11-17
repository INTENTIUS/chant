/**
 * #4521 on the k8s lexicon: discovery's group/version/kind mapped to kinds,
 * and a fixture listing typed into nodes through the k8s hooks.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveEdges } from "@intentius/chant/lifecycle/derive-edges";
import { typeListing, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { MASKED } from "@intentius/chant/deep-observation";
import { operationTable } from "./api/operation-surface";
import { k8sKindForListedType, k8sListedTypeFor } from "./listed-types";
import { k8sPlugin } from "./plugin";

const here = import.meta.dirname;
const surface = JSON.parse(readFileSync(join(here, "..", "surface.snapshot.json"), "utf-8")) as {
  entries: Record<string, { kind: string; resourceType: string }>;
};
const KINDS: ReadonlySet<string> = new Set(
  Object.values(surface.entries).filter((e) => e.kind === "resource").map((e) => e.resourceType),
);
const listing = JSON.parse(readFileSync(join(here, "testdata", "indexed", "listing.json"), "utf-8")) as ListingResult;
const hasGenerated = existsSync(join(here, "generated", "operations.json"));

const k8s: ListingLexicon = {
  name: k8sPlugin.name,
  deepNormalizationHooks: k8sPlugin.deepNormalizationHooks,
  listedTypes: { ...k8sPlugin.listedTypes!, kindFor: (t) => k8sKindForListedType(t, KINDS) },
};

describe("discovery types to k8s kinds", () => {
  it("maps group/version/kind through the shared group rule; the version is not part of the kind", () => {
    expect(k8sKindForListedType("v1/Pod", KINDS)).toBe("K8s::Core::Pod");
    expect(k8sKindForListedType("apps/v1/Deployment", KINDS)).toBe("K8s::Apps::Deployment");
    expect(k8sKindForListedType("apps/v1beta2/Deployment", KINDS)).toBe("K8s::Apps::Deployment");
    expect(k8sKindForListedType("networking.k8s.io/v1/Ingress", KINDS)).toBe("K8s::Networking::Ingress");
    expect(k8sKindForListedType("rbac.authorization.k8s.io/v1/ClusterRole", KINDS)).toBe("K8s::Rbac::ClusterRole");
    expect(k8sKindForListedType("kustomize.toolkit.fluxcd.io/v1/Kustomization", KINDS)).toBe("K8s::Flux::Kustomization");
    expect(k8sKindForListedType("argoproj.io/v1alpha1/Application", KINDS)).toBe("K8s::Argo::Application");
    expect(k8sKindForListedType("widgets.example.com/v1alpha1/Widget", KINDS)).toBeUndefined();
    expect(k8sKindForListedType("Deployment", KINDS)).toBeUndefined();
  });

  it.skipIf(!hasGenerated)("every kind of the generated operation surface maps back from its apiVersion and kind", () => {
    const table = operationTable();
    const kinds = new Set(Object.keys(table));
    const missing = Object.values(table).filter((d) => k8sKindForListedType(k8sListedTypeFor(d.apiVersion, d.kind), kinds) !== d.entityType);
    expect(missing.map((d) => d.entityType)).toEqual([]);
  });
});

describe("the k8s fixture listing as typed nodes", () => {
  const doc = typeListing(listing, [k8s]);

  it("produces typed nodes, and keeps the unmapped custom resource as an unknown-kind node", () => {
    expect(doc.graph.nodes.map((n) => [n.nativeId, n.kind, n.lexicon, n.unmappedKind ?? false])).toEqual([
      ["flux-system/apps", "K8s::Flux::Kustomization", "k8s", false],
      ["shop/web", "K8s::Apps::Deployment", "k8s", false],
      ["shop/db-credentials", "K8s::Core::Secret", "k8s", false],
      ["shop/w1", "widgets.example.com/v1alpha1/Widget", "kubernetes", true],
    ]);
  });

  it("drops apiVersion and kind, and prunes what the k8s hooks prune", () => {
    const web = doc.graph.nodes.find((n) => n.nativeId === "shop/web")!;
    expect(web.attrs.apiVersion).toBeUndefined();
    expect(web.attrs.kind).toBeUndefined();
    expect(web.attrs.status).toBeUndefined();
    expect((web.attrs.metadata as Record<string, unknown>).uid).toBeUndefined();
    expect(web.attrs.spec).toEqual({ replicas: 2, selector: { matchLabels: { app: "web" } } });
  });

  it("masks a Secret's data whatever its keys are called", () => {
    const secret = doc.graph.nodes.find((n) => n.kind === "K8s::Core::Secret")!;
    expect(secret.attrs.data).toEqual({ "app.conf": MASKED });
  });
});

describe("a kind the reference catalog names (#5244)", () => {
  const es = (name: string, store: string) => ({
    apiVersion: "external-secrets.io/v1",
    kind: "ExternalSecret",
    metadata: { name, namespace: "shop", uid: `uid-${name}`, resourceVersion: "4" },
    spec: { secretStoreRef: { name: store, kind: "ClusterSecretStore" }, data: [{ secretKey: "pw", remoteRef: { key: "shop/db" } }] },
    status: { refreshTime: "2026-11-16T00:00:00Z" },
  });
  const store = {
    apiVersion: "external-secrets.io/v1",
    kind: "ClusterSecretStore",
    metadata: { name: "aws", uid: "uid-store" },
    spec: { provider: { aws: { service: "SecretsManager", region: "us-east-1" } } },
  };
  const widget = { apiVersion: "widgets.example.com/v1alpha1", kind: "Widget", metadata: { name: "w1", namespace: "shop", uid: "uid-w" } };
  const res = (listedType: string, location: string, name: string, properties: Record<string, unknown>) => ({
    listedType,
    location,
    nativeId: location === "cluster" ? name : `${location}/${name}`,
    cloudIds: [],
    tags: {},
    properties,
    observedAt: "2026-11-16T00:00:00.000Z",
  });
  const catalogListing: ListingResult = {
    ...listing,
    resources: [
      res("external-secrets.io/v1/ExternalSecret", "shop", "db", es("db", "aws")),
      res("external-secrets.io/v1/ClusterSecretStore", "cluster", "aws", store),
      res("widgets.example.com/v1alpha1/Widget", "shop", "w1", widget),
    ],
  };

  it("types the external-secrets kinds, drops apiVersion and kind, and prunes status", () => {
    const doc = typeListing(catalogListing, [k8s]);
    const kinds = Object.fromEntries(doc.graph.nodes.map((n) => [n.nativeId, [n.kind, n.lexicon]]));
    expect(kinds["shop/db"]).toEqual(["K8s::ExternalSecrets::ExternalSecret", "k8s"]);
    expect(kinds["aws"]).toEqual(["K8s::ExternalSecrets::ClusterSecretStore", "k8s"]);
    const secret = doc.graph.nodes.find((n) => n.nativeId === "shop/db")!;
    expect(secret.attrs.apiVersion).toBeUndefined();
    expect(secret.attrs.kind).toBeUndefined();
    expect(secret.attrs.status).toBeUndefined();
    expect((secret.attrs.spec as { secretStoreRef: unknown }).secretStoreRef).toEqual({ name: "aws", kind: "ClusterSecretStore" });
  });

  it("keeps the listed type of a CRD kind the catalog does not name", () => {
    const doc = typeListing(catalogListing, [k8s]);
    const w = doc.graph.nodes.find((n) => n.nativeId === "shop/w1")!;
    expect([w.kind, w.lexicon, w.unmappedKind]).toEqual(["widgets.example.com/v1alpha1/Widget", "kubernetes", true]);
  });

  it("draws the derived edge from an ExternalSecret to the ClusterSecretStore it names", () => {
    const doc = deriveEdges(typeListing(catalogListing, [k8s]), [{ name: "k8s", referenceCatalog: k8sPlugin.referenceCatalog }]);
    const from = doc.graph.nodes.find((n) => n.nativeId === "shop/db")!.id;
    const to = doc.graph.nodes.find((n) => n.nativeId === "aws")!.id;
    expect(doc.graph.edges.some((e) => e.from === from && e.to === to)).toBe(true);
  });
});
