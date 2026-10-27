/**
 * #4538 on the k8s lexicon: `chant import --index` through the k8s seam,
 * and the identity rule `chant search --index` and the identity edge pass
 * join k8s rows with.
 *
 * The listing is the #4521 fixture (testdata/indexed/listing.json: a
 * Deployment, a Secret, a Flux Kustomization, an unmapped custom resource)
 * plus a ConfigMap whose `db.password` key the listing masks by name, a
 * ReplicaSet the Deployment owns, and a ClusterRole. It is typed through the
 * k8s hooks as `behold index` writes it, then imported through the seam and
 * `K8sGenerator`, the codegen `chant import <manifest>` uses.
 *
 * The cluster round trip (index a kind cluster, import, build, apply with
 * markers, then search binds every row) is a maintainer run.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadAll } from "js-yaml";
import { build } from "@intentius/chant/build";
import { MASKED } from "@intentius/chant/deep-observation";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { SerializerResult } from "@intentius/chant/serializer";
import { matchDeclaredToIndex } from "@intentius/chant/lifecycle/identity-match";
import { planIndexImport } from "@intentius/chant/lifecycle/index-import";
import { typeListing, type ListedResource, type ListingLexicon, type ListingResult } from "@intentius/chant/lifecycle/type-listing";
import { renderIndexImport } from "@intentius/chant/cli/commands/import-index";
import type { K8sOperationTable } from "./api/operation-surface";
import { createK8sIndexIdentity, k8sDeclaredIdentity, k8sNodeIdentities } from "./index-identity";
import { k8sImportProperties, maskedValueEnvVar } from "./index-import";
import { k8sKindForListedType } from "./listed-types";
import { k8sPlugin } from "./plugin";
import { k8sSerializer } from "./serializer";

const here = import.meta.dirname;
const surface = JSON.parse(readFileSync(join(here, "..", "surface.snapshot.json"), "utf-8")) as {
  entries: Record<string, { kind: string; resourceType: string }>;
};
const KINDS: ReadonlySet<string> = new Set(Object.values(surface.entries).filter((e) => e.kind === "resource").map((e) => e.resourceType));

const TABLE: K8sOperationTable = {
  "K8s::Apps::Deployment": { entityType: "K8s::Apps::Deployment", apiVersion: "apps/v1", kind: "Deployment", plural: "deployments", scope: "Namespaced", verbs: [] },
  "K8s::Core::Secret": { entityType: "K8s::Core::Secret", apiVersion: "v1", kind: "Secret", plural: "secrets", scope: "Namespaced", verbs: [] },
  "K8s::Core::ConfigMap": { entityType: "K8s::Core::ConfigMap", apiVersion: "v1", kind: "ConfigMap", plural: "configmaps", scope: "Namespaced", verbs: [] },
  "K8s::Rbac::ClusterRole": { entityType: "K8s::Rbac::ClusterRole", apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", plural: "clusterroles", scope: "Cluster", verbs: [] },
};

const k8sListing: ListingLexicon = {
  name: k8sPlugin.name,
  deepNormalizationHooks: k8sPlugin.deepNormalizationHooks,
  listedTypes: { ...k8sPlugin.listedTypes!, kindFor: (t) => k8sKindForListedType(t, KINDS) },
};

function obj(listedType: string, location: string, name: string, uid: string, properties: Record<string, unknown>): ListedResource {
  return {
    listedType,
    location,
    nativeId: location === "cluster" ? name : `${location}/${name}`,
    cloudIds: [{ kind: "k8s-uid", value: uid }],
    tags: {},
    properties,
    observedAt: "2026-10-26T09:00:01.000Z",
  };
}

const base = JSON.parse(readFileSync(join(here, "testdata", "indexed", "listing.json"), "utf-8")) as ListingResult;
const listing: ListingResult = {
  ...base,
  resources: [
    ...base.resources,
    obj("v1/ConfigMap", "shop", "app", "uid-cm", {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "app", namespace: "shop", uid: "uid-cm", resourceVersion: "9", annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}" } },
      data: { "db.host": "db.shop.svc", "db.password": "hunter2" },
    }),
    obj("apps/v1/ReplicaSet", "shop", "web-5d8f", "uid-rs", {
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: { name: "web-5d8f", namespace: "shop", ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "5f1c2a8e-0000-4000-8000-000000000001" }] },
      spec: { replicas: 2 },
    }),
    obj("rbac.authorization.k8s.io/v1/ClusterRole", "cluster", "reader", "uid-cr", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name: "reader" },
      rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }],
    }),
  ],
};
const doc = typeListing(listing, [k8sListing]);
const node = (nativeId: string) => doc.graph.nodes.find((n) => n.nativeId === nativeId)!;

const identity = createK8sIndexIdentity(TABLE);
const plugin = k8sPlugin as LexiconPlugin;

function primary(out: string | SerializerResult | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : out.primary;
}

describe("the k8s identity rule", () => {
  test("a namespaced object is <namespace>/<name> at its namespace, matched by kind", () => {
    expect(k8sDeclaredIdentity("K8s::Apps::Deployment", { metadata: { name: "web", namespace: "shop" } }, TABLE)).toEqual({
      kind: "identifier",
      listedType: "apps/v1/Deployment",
      identifier: "shop/web",
      global: false,
      location: "shop",
      entityKind: "K8s::Apps::Deployment",
    });
  });

  test("a cluster-scoped object is its name at location cluster", () => {
    expect(k8sDeclaredIdentity("K8s::Rbac::ClusterRole", { metadata: { name: "reader" } }, TABLE)).toMatchObject({
      kind: "identifier",
      identifier: "reader",
      location: "cluster",
      listedType: "rbac.authorization.k8s.io/v1/ClusterRole",
    });
  });

  test("a declared apiVersion is the listed type's version", () => {
    expect(k8sDeclaredIdentity("K8s::Apps::Deployment", { apiVersion: "apps/v1beta2", metadata: { name: "web", namespace: "shop" } }, TABLE)).toMatchObject({
      listedType: "apps/v1beta2/Deployment",
    });
  });

  test("no name, a generated name, or no namespace cannot match; an unknown kind is unsupported", () => {
    expect(k8sDeclaredIdentity("K8s::Apps::Deployment", { metadata: { namespace: "shop" } }, TABLE)).toMatchObject({ kind: "unmatchable", reason: "no-binding" });
    expect(k8sDeclaredIdentity("K8s::Apps::Deployment", { metadata: { generateName: "web-", namespace: "shop" } }, TABLE)).toMatchObject({
      kind: "unmatchable",
      reason: "no-binding",
      detail: expect.stringMatching(/generateName/),
    });
    expect(k8sDeclaredIdentity("K8s::Apps::Deployment", { metadata: { name: "web" } }, TABLE)).toMatchObject({
      kind: "unmatchable",
      reason: "no-binding",
      detail: expect.stringMatching(/namespace/),
    });
    expect(k8sDeclaredIdentity("K8s::Sops::EncryptedSecretFile", { metadata: { name: "x" } }, TABLE)).toMatchObject({ kind: "unmatchable", reason: "unsupported-kind" });
  });

  test("an indexed object is named by its native id and its uid", () => {
    expect(k8sNodeIdentities(node("shop/web"))).toEqual([
      { kind: "native-id", value: "shop/web" },
      { kind: "k8s-uid", value: "5f1c2a8e-0000-4000-8000-000000000001" },
    ]);
  });

  test("declared rows bind, read absent, or read not observed against the index", () => {
    const { matches } = matchDeclaredToIndex(
      [
        { name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "shop" } } },
        // Another version of the same kind binds: the match is by kind.
        { name: "webOld", entityType: "K8s::Apps::Deployment", props: { apiVersion: "apps/v1beta2", metadata: { name: "web", namespace: "shop" } } },
        { name: "reader", entityType: "K8s::Rbac::ClusterRole", props: { metadata: { name: "reader" } } },
        { name: "api", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "api", namespace: "shop" } } },
        { name: "loose", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "loose" } } },
      ],
      [doc],
      identity,
    );
    expect(matches.web).toMatchObject({ verdict: "bound", node: node("shop/web").id, location: "shop" });
    expect(matches.webOld).toMatchObject({ verdict: "bound", node: node("shop/web").id });
    expect(matches.reader).toMatchObject({ verdict: "bound", node: node("reader").id, location: "cluster" });
    expect(matches.api).toMatchObject({ verdict: "absent", identifier: "shop/api", location: "shop" });
    expect(matches.loose).toMatchObject({ verdict: "not-observed", reason: "no-binding" });
  });

  test("the plugin declares the identity rule", () => {
    expect(k8sPlugin.indexIdentity?.substrate).toBe("kubernetes");
  });
});

describe("chant import --index on the k8s fixture", () => {
  const plan = planIndexImport([doc], { all: true }, [k8sPlugin]);
  const report = new Map(plan.report.resources.map((r) => [r.identity.nativeId, r]));

  test("server-written fields and chant's own labels are left out; apiVersion only when the version differs", () => {
    const props = k8sImportProperties(node("shop/web"));
    expect(props).toEqual({ metadata: { labels: { app: "web" }, name: "web", namespace: "shop" }, spec: { replicas: 2, selector: { matchLabels: { app: "web" } } } });
    expect(k8sImportProperties({ ...node("shop/web"), listedType: "apps/v1beta2/Deployment" }).apiVersion).toBe("apps/v1beta2");
  });

  test("an owned object, and a kind with no lexicon mapping, are refused by name", () => {
    expect(report.get("shop/web-5d8f")).toMatchObject({ status: "unsupported", reason: expect.stringMatching(/owned by Deployment\/web/) });
    expect(report.get("shop/w1")).toMatchObject({ status: "unsupported", reason: expect.stringMatching(/no lexicon kind maps/) });
  });

  test("a masked Secret is a referenced secret; another masked value is a parameter read from the environment", () => {
    expect(report.get("shop/db-credentials")).toMatchObject({ status: "imported" });
    expect(report.get("shop/db-credentials")!.parameters).toBeUndefined();
    const cm = report.get("shop/app")!;
    expect(cm.status).toBe("imported");
    expect(cm.parameters).toHaveLength(1);
    expect(plan.report.parameters).toEqual([{ name: cm.parameters![0], node: cm.node, path: "data.db.password", group: expect.any(String) }]);
    expect(node("shop/app").attrs.data).toEqual({ "db.host": "db.shop.svc", "db.password": MASKED });
  });

  test("round trip: import, build, and every imported object comes back with its indexed fields", async () => {
    const { files, warnings } = renderIndexImport(plan, [plugin]);
    expect(warnings).toEqual([]);
    const all = files.map((f) => f.content).join("\n");
    expect(all).toContain('import { declareSecret } from "@intentius/chant";');
    expect(all).toMatch(/declareSecret\(\{\s+name: "db-credentials",\s+provenance: "referenced",\s+scope: "shop",\s+\}\)/);
    expect(all).toContain("keys app.conf");
    expect(all).not.toContain(MASKED);
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("5f1c2a8e");

    const cm = report.get("shop/app")!;
    const envVar = maskedValueEnvVar(cm.parameters![0]);
    expect(all).toContain(`maskedValue("${envVar}")`);

    const dir = mkdtempSync(join(here, "../.index-import-tmp-"));
    const saved = process.env[envVar];
    process.env[envVar] = "from-env";
    try {
      const src = join(dir, "src");
      for (const f of files) {
        mkdirSync(join(src, f.path, ".."), { recursive: true });
        writeFileSync(join(src, f.path), f.content);
      }
      const result = await build(src, [k8sSerializer]);
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const docs = (loadAll(primary(result.outputs.get("k8s"))) as Array<Record<string, any>>).filter((d) => d);
      const byKind = new Map(docs.map((d) => [`${d.kind}/${d.metadata?.name}`, d]));
      expect(byKind.get("Deployment/web")).toMatchObject({ apiVersion: "apps/v1", metadata: { name: "web", namespace: "shop" }, spec: { replicas: 2 } });
      expect(byKind.get("ConfigMap/app")).toMatchObject({ data: { "db.host": "db.shop.svc", "db.password": "from-env" } });
      expect(byKind.get("ClusterRole/reader")).toMatchObject({ rules: [{ verbs: ["get", "list"] }] });
      // The Secret is supplied out of band; nothing writes it.
      expect(byKind.has("Secret/db-credentials")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env[envVar];
      else process.env[envVar] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the plugin declares the seam", () => {
    expect(k8sPlugin.indexImport).toBeDefined();
  });
});
