/**
 * ApplicationSet expansion end to end (#5102): `chant workspace graph
 * --discover` over a scratch git repository with Argo CD manifests, read
 * through the k8s lexicon installed in this checkout. Each fixture is its own
 * `git init` in a scratch location with an origin the Applications name, so
 * nothing writes into this repository's git directory. Nothing is removed.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { contract, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { CACHE_DIR_ENV } from "./graph-cache";
import { workspaceGraph, type GraphDocument } from "./graph-cli";
import schema from "./graph.schema.json";

const TIMEOUT = 240_000;
const { expectValid } = contract(schema);

let cacheBefore: string | undefined;
beforeAll(() => {
  cacheBefore = process.env[CACHE_DIR_ENV];
  process.env[CACHE_DIR_ENV] = scratchDir("chant-appset-cache-");
});
afterAll(() => {
  if (cacheBefore === undefined) delete process.env[CACHE_DIR_ENV];
  else process.env[CACHE_DIR_ENV] = cacheBefore;
  // The scratch directories are left in place for the run's cleanup.
});

const ORIGIN = "https://example.com/estate.git";

const secret = (name: string, cloud: string) => `---
apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    cloud: ${cloud}
stringData:
  name: ${name}
  server: https://${name}.example.com
`;

const CLUSTERS_SET = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: app
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - clusters:
        selector:
          matchLabels:
            cloud: gke
  template:
    metadata:
      name: "app-{{ .name }}"
    spec:
      project: default
      source:
        repoURL: ${ORIGIN}
        path: clusters/{{ .name }}/app
      destination:
        server: "{{ .server }}"
        namespace: app
`;

const LIST_SET = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: tools
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - tool: lint
            cluster: a
          - tool: docs
            cluster: b
  template:
    metadata:
      name: "tools-{{tool}}"
    spec:
      project: default
      source:
        repoURL: ${ORIGIN}
        path: tools/{{tool}}
      destination:
        name: "{{cluster}}"
        namespace: tools
`;

const GIT_SET = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: dirs
  namespace: argocd
spec:
  generators:
    - git:
        repoURL: ${ORIGIN}
        revision: HEAD
        directories:
          - path: apps/*
  template:
    metadata:
      name: "{{path.basename}}"
    spec:
      project: default
      source:
        repoURL: ${ORIGIN}
        path: "{{path}}"
      destination:
        name: a
        namespace: default
`;

const SET = "argo/argo/applicationSetApp";
const GENERATES = "k8s:K8s::Argo::ApplicationSet:spec.generators";
const PATH_RULE = "k8s:K8s::Argo::Application:spec.source.path";
const SELECTED = "k8s:K8s::Argo::ApplicationSet:generators[].clusters";
const secretId = (name: string) => `argo/argo/secret${name.toUpperCase()}`;

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

async function read(files: Record<string, string>) {
  const root = scratchDir("chant-appset-fx-");
  writeFiles(root, files);
  git(root, "init", "-q");
  git(root, "remote", "add", "origin", ORIGIN);
  const g = result((await workspaceGraph({ cwd: root, discover: true, noCache: false, catalog: true, args: { detail: 3 } as never })).doc);
  expectValid(g);
  return g;
}

describe("ApplicationSet expansion (#5102)", () => {
  test(
    "a clusters generator makes one Application per selected Secret, with its path and an edge to the Secret",
    async () => {
      const g = await read({ "argo/clusters.yaml": secret("a", "gke") + secret("b", "eks"), "argo/appset.yaml": CLUSTERS_SET, "clusters/a/app/kustomization.yaml": "resources: []\n" });
      const generated = g.nodes.filter((n) => n.generatedBy);
      expect(generated.map((n) => n.id)).toEqual([`${SET}/app-a`]);
      const app = generated[0];
      expect(app.kind).toBe("K8s::Argo::Application");
      expect((app.attrs.spec as { source: { path: string } }).source.path).toBe("clusters/a/app");
      expect(app.generatedBy).toMatchObject({ node: SET, rule: GENERATES, generator: "clusters", cluster: secretId("a") });
      expect(app.generatedBy!.params).toMatchObject({ name: "a", server: "https://a.example.com", "metadata.labels.cloud": "gke" });
      const edges = g.edges.map((e) => `${e.from} > ${e.to} ${e.rule ?? ""}`);
      expect(edges).toContain(`${SET} > ${SET}/app-a ${GENERATES}`);
      // The generator selected Secret a, so the edge is under its own rule, and the destination rule draws no second one.
      expect(edges.filter((e) => e.startsWith(`${SET}/app-a > `))).toEqual([`${SET}/app-a > ${secretId("a")} ${SELECTED}`]);
      expect(g.catalog?.rules[SELECTED]).toMatchObject({ lexicon: "k8s", from: "K8s::Argo::ApplicationSet", targetKinds: ["K8s::Core::Secret"], label: "deploys to" });
      expect(g.nodes.find((n) => n.id === SET)?.expansion).toEqual({ rule: GENERATES, generated: 1, notExpanded: [] });
      expect((g.dangling ?? []).filter((d) => d.rule === PATH_RULE)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a generated Application joins the Secret it was selected for across members and namespaces; a hand-written one with no namespace does not",
    async () => {
      const unplaced = CLUSTERS_SET.replace("  namespace: argocd\n", "");
      const hand = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: web
spec:
  project: default
  source:
    repoURL: ${ORIGIN}
    path: clusters/a/app
  destination:
    name: a
    namespace: web
`;
      const g = await read({ "argo/clusters.yaml": secret("a", "gke"), "apps/appset.yaml": unplaced, "apps/web.yaml": hand, "clusters/a/app/x.yaml": "" });
      const edges = g.edges.map((e) => `${e.from} > ${e.to} ${e.rule ?? ""}`);
      expect(edges).toContain(`apps/apps/applicationSetApp/app-a > ${secretId("a")} ${SELECTED}`);
      expect(edges.filter((e) => e.startsWith("apps/apps/applicationWeb > "))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a missing $values file is dangling once, under the helm rule, on a hand-written Application and on a generated one (#5094)",
    async () => {
      const sources = (name: string) => `    - chart: c
      repoURL: https://charts.example.com
      targetRevision: 1.0.0
      helm:
        valueFiles:
          - $values/helm/${name}.yaml
    - repoURL: ${ORIGIN}
      targetRevision: main
      ref: values
`;
      const hand = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: web
  namespace: argocd
spec:
  project: default
  sources:
${sources("x")}  destination:
    name: a
    namespace: web
`;
      const set = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: vals
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - clusters:
        selector:
          matchLabels:
            cloud: gke
  template:
    metadata:
      name: "vals-{{ .name }}"
    spec:
      project: default
      sources:
${sources("{{ .name }}").replace(/^(?=.)/gm, "    ")}      destination:
        server: "{{ .server }}"
        namespace: vals
`;
      const g = await read({ "argo/clusters.yaml": secret("a", "gke"), "argo/web.yaml": hand, "argo/vals.yaml": set });
      const values = (g.dangling ?? []).filter((d) => d.value.includes("helm/")).map((d) => `${d.from} ${d.rule} ${d.value}`);
      expect(values).toEqual([
        "argo/argo/applicationSetVals/vals-a k8s:K8s::Argo::Application:helmReferences.valuesFiles[] helm/a.yaml",
        "argo/argo/applicationWeb k8s:K8s::Argo::Application:helmReferences.valuesFiles[] helm/x.yaml",
      ]);
    },
    TIMEOUT,
  );

  test(
    "a generated Application's chart and values file join the Helm graph, and the file's extraObjects are nodes other objects join (#5094)",
    async () => {
      const set = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: eso
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - clusters:
        selector:
          matchLabels:
            cloud: gke
  template:
    metadata:
      name: "eso-{{ .name }}"
    spec:
      project: default
      sources:
        - chart: external-secrets
          repoURL: https://charts.example.com
          targetRevision: 2.0.0
          helm:
            valueFiles:
              - $values/clusters/{{ .name }}/helm/eso.yaml
        - repoURL: ${ORIGIN}
          targetRevision: main
          ref: values
      destination:
        server: "{{ .server }}"
        namespace: external-secrets
`;
      const values = `extraObjects:
  - apiVersion: external-secrets.io/v1
    kind: ClusterSecretStore
    metadata:
      name: store-a
    spec:
      provider:
        gcpsm:
          projectID: project-a
`;
      const externalSecret = `apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: token
  namespace: web
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: store-a
  data:
    - secretKey: token
      remoteRef:
        key: token
`;
      // A hand-written Application with a values file puts a helm node in the graph, so the helm lexicon's catalog, which makes chart nodes, is loaded.
      const hand = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: web
  namespace: argocd
spec:
  project: default
  sources:
    - chart: web
      repoURL: https://charts.example.com
      targetRevision: 1.0.0
      helm:
        valueFiles:
          - $values/helm/web.yaml
    - repoURL: ${ORIGIN}
      targetRevision: main
      ref: values
  destination:
    name: a
    namespace: web
`;
      const g = await read({ "argo/clusters.yaml": secret("a", "gke"), "argo/eso.yaml": set, "argo/web.yaml": hand, "helm/web.yaml": "replicas: 1\n", "clusters/a/helm/eso.yaml": values, "web/es.yaml": externalSecret });
      const app = "argo/argo/applicationSetEso/eso-a";
      const valuesNode = `argo/argo/applicationSetEso/values/clusters/a/helm/eso.yaml`;
      const store = `${valuesNode}/clusterSecretStoreStoreA`;
      expect((g.nodes.find((n) => n.id === app)?.attrs as { helmReferences?: unknown }).helmReferences).toEqual({
        charts: [{ repo: "https://charts.example.com", chart: "external-secrets", version: "2.0.0", valuesFiles: ["clusters/a/helm/eso.yaml"] }],
        valuesFiles: ["clusters/a/helm/eso.yaml"],
      });
      const values_ = g.nodes.find((n) => n.id === valuesNode);
      expect(values_).toMatchObject({ kind: "Helm::Values", lexicon: "helm", member: "argo", generatedBy: { node: app, generator: "file" } });
      expect(values_?.attrs).toMatchObject({ path: "clusters/a/helm/eso.yaml", charts: [{ repo: "https://charts.example.com", chart: "external-secrets", version: "2.0.0" }] });
      expect(g.nodes.find((n) => n.id === store)).toMatchObject({ kind: "K8s::ExternalSecrets::ClusterSecretStore", lexicon: "k8s", member: "argo" });
      const edges = g.edges.map((e) => `${e.from} > ${e.to} ${e.rule ?? ""}`);
      expect(edges).toContain(`${app} > ${valuesNode} k8s:K8s::Argo::Application:helmReferences.valuesFiles[]`);
      expect(edges.some((e) => e.startsWith(`${app} > `) && e.includes("chart:charts.example.com/external-secrets@2.0.0"))).toBe(true);
      expect(edges.some((e) => e.startsWith(`${valuesNode} > `) && e.endsWith("helm:Helm::Values:charts"))).toBe(true);
      expect(edges.filter((e) => e.startsWith("web/web/externalSecretToken > ") && e.includes(store))).toHaveLength(1);
      expect((g.dangling ?? []).filter((d) => d.value.includes("eso.yaml"))).toEqual([]);
      expectValid(g);
    },
    TIMEOUT,
  );

  test(
    "a two-element list generator makes two Applications",
    async () => {
      const g = await read({ "argo/clusters.yaml": secret("a", "gke") + secret("b", "eks"), "argo/tools.yaml": LIST_SET, "tools/lint/x.yaml": "", "tools/docs/x.yaml": "" });
      const generated = g.nodes.filter((n) => n.generatedBy).map((n) => `${n.id} ${n.generatedBy!.params.tool}`);
      expect(generated).toEqual(["argo/argo/applicationSetTools/tools-docs docs", "argo/argo/applicationSetTools/tools-lint lint"]);
      const toSecrets = g.edges.filter((e) => e.rule === "k8s:K8s::Argo::Application:spec.destination.name").map((e) => `${e.from} > ${e.to}`);
      expect(toSecrets).toEqual([`argo/argo/applicationSetTools/tools-docs > ${secretId("b")}`, `argo/argo/applicationSetTools/tools-lint > ${secretId("a")}`]);
    },
    TIMEOUT,
  );

  test(
    "a selected cluster whose path is missing puts the path in dangling, naming the ApplicationSet and the cluster",
    async () => {
      const g = await read({
        "argo/clusters.yaml": secret("a", "gke") + secret("b", "eks") + secret("c", "gke"),
        "argo/appset.yaml": CLUSTERS_SET,
        "clusters/a/app/kustomization.yaml": "resources: []\n",
      });
      expect(g.nodes.filter((n) => n.generatedBy).map((n) => n.id)).toEqual([`${SET}/app-a`, `${SET}/app-c`]);
      expect((g.dangling ?? []).filter((d) => d.rule === PATH_RULE)).toEqual([
        { from: `${SET}/app-c`, kind: "ref", path: "spec.source.path", value: "clusters/c/app", member: "argo", rule: PATH_RULE, through: SET, cluster: secretId("c") },
      ]);
    },
    TIMEOUT,
  );

  test(
    "a git generator keeps the ApplicationSet node and notes that it is not expanded",
    async () => {
      const g = await read({ "argo/clusters.yaml": secret("a", "gke"), "argo/dirs.yaml": GIT_SET });
      expect(g.nodes.filter((n) => n.generatedBy)).toEqual([]);
      const set = g.nodes.find((n) => n.id === "argo/argo/applicationSetDirs");
      expect(set?.kind).toBe("K8s::Argo::ApplicationSet");
      expect(set?.expansion).toEqual({ rule: GENERATES, generated: 0, notExpanded: ["generators[0]: the git generator is not expanded"] });
    },
    TIMEOUT,
  );

  test(
    "at --detail 0 a generated Application is drawn as its ApplicationSet's stack",
    async () => {
      const root = scratchDir("chant-appset-fx-");
      writeFiles(root, { "argo/clusters.yaml": secret("a", "gke"), "argo/appset.yaml": CLUSTERS_SET, "clusters/a/app/x.yaml": "" });
      git(root, "init", "-q");
      git(root, "remote", "add", "origin", ORIGIN);
      const g = result((await workspaceGraph({ cwd: root, discover: true, noCache: false, catalog: true, args: { detail: 0 } as never })).doc);
      expectValid(g);
      expect(g.nodes.some((n) => n.generatedBy)).toBe(false);
      expect(g.nodes.some((n) => n.id.includes("app-a"))).toBe(false);
      expect(g.edges.some((e) => e.rule === GENERATES)).toBe(false);
    },
    TIMEOUT,
  );
});
