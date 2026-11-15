/**
 * Helm charts and values files on `chant workspace graph --discover` (#5100),
 * read as data: a kustomization's `helmCharts`, a Terraform `helm_release` and
 * an Argo CD Application name one chart, and each values file they name is a
 * node. The read runs with no `kustomize`, `kubectl`, `helm` or `terraform` on
 * PATH, and with no network.
 */

import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { CACHE_DIR_ENV } from "./graph-cache";
import { workspaceGraph, type GraphDocument } from "./graph-cli";
import schema from "./graph.schema.json";

const TIMEOUT = 240_000;
const { expectValid } = contract(schema);

let cacheBefore: string | undefined;
let pathBefore: string | undefined;
beforeAll(() => {
  cacheBefore = process.env[CACHE_DIR_ENV];
  process.env[CACHE_DIR_ENV] = scratchDir("chant-helm-cache-");
  // Only node's own directory and the system tools: none of the four binaries the read could use.
  pathBefore = process.env.PATH;
  process.env.PATH = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");
});
afterAll(() => {
  if (cacheBefore === undefined) delete process.env[CACHE_DIR_ENV];
  else process.env[CACHE_DIR_ENV] = cacheBefore;
  process.env.PATH = pathBefore;
  cleanScratch();
});

const KUSTOMIZATION =
  "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nhelmCharts:\n  - name: datadog\n    repo: https://helm.datadoghq.com\n    version: 3.244.0\n    releaseName: datadog\n    valuesFile: values.yaml\n";

const DD = {
  "k8s/dd/kustomization.yaml": KUSTOMIZATION,
  "k8s/dd/values.yaml": "datadog:\n  site: datadoghq.com\nextraObjects:\n  - apiVersion: external-secrets.io/v1beta1\n    kind: SecretStore\n    metadata:\n      name: dd-store\n",
  "tf/main.tf": 'resource "helm_release" "datadog" {\n  name       = "datadog"\n  repository = "https://helm.datadoghq.com/"\n  chart      = "datadog"\n  version    = "3.244.0"\n}\n',
};

const MORE = {
  ...DD,
  "k8s/gone/kustomization.yaml":
    "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nhelmCharts:\n  - name: redis\n    repo: https://charts.example.com\n    version: 1.0.0\n    valuesFile: missing.yaml\n",
  "argo/app.yaml":
    "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: dd\n  namespace: argocd\nspec:\n  project: default\n  sources:\n    - repoURL: https://helm.datadoghq.com\n      chart: datadog\n      targetRevision: 3.244.0\n      helm:\n        valueFiles:\n          - $values/k8s/dd/values.yaml\n    - repoURL: https://example.com/repo.git\n      targetRevision: main\n      ref: values\n  destination:\n    server: https://kubernetes.default.svc\n    namespace: dd\n",
};

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

async function read(files: Record<string, string>, detail?: number) {
  const root = scratchDir("chant-helm-fx-");
  writeFiles(root, files);
  const { doc } = await workspaceGraph({ cwd: root, discover: true, noCache: false, catalog: true, ...(detail ? { args: { detail } as never } : {}) });
  const g = result(doc);
  expectValid(g);
  return g;
}

describe("helm charts and values files as data (#5100)", () => {
  test(
    "a kustomization and a helm_release that name one chart: one chart node, one values node, an edge to the chart from each",
    async () => {
      const g = await read(DD, 3);
      const charts = g.nodes.filter((n) => n.kind === "Helm::ChartRef");
      expect(charts.map((c) => c.attrs)).toEqual([{ repo: "https://helm.datadoghq.com", chart: "datadog", version: "3.244.0" }]);
      const values = g.nodes.filter((n) => n.kind === "Helm::Values");
      expect(values.map((v) => v.attrs.path)).toEqual(["k8s/dd/values.yaml"]);
      expect(values[0].attrs.values).toMatchObject({ datadog: { site: "datadoghq.com" } });

      const toChart = g.edges.filter((e) => e.to === charts[0].id).map((e) => [e.from, e.rule]);
      expect(toChart).toEqual([
        ["k8s-dd/k8s-dd/kustomizationK8sDd", "helm:K8s::Kustomize::Kustomization:helmReferences.charts"],
        ["k8s-dd/k8s-dd/values/k8s/dd/values.yaml", "helm:Helm::Values:charts"],
        ["tf/tf/helm_release.datadog", "helm:helm_release:chart"],
      ]);
      expect(g.edges.filter((e) => e.to === values[0].id).map((e) => e.from)).toEqual(["k8s-dd/k8s-dd/kustomizationK8sDd"]);
      expect(g.dangling ?? []).toEqual([]);
      // What a values file's extraObjects creates is a node of the member.
      expect(g.nodes.filter((n) => n.kind === "K8s::ExternalSecrets::SecretStore").map((n) => n.id)).toEqual(["k8s-dd/k8s-dd/secretStoreDdStore"]);
    },
    TIMEOUT,
  );

  test(
    "an Argo CD source joins the same chart, its $values file is read from the workspace, and a values file that does not exist is dangling with its path",
    async () => {
      const g = await read(MORE);
      const charts = g.nodes.filter((n) => n.kind === "Helm::ChartRef");
      expect(charts.map((c) => c.attrs.chart).sort()).toEqual(["datadog", "redis"]);
      const datadog = charts.find((c) => c.attrs.chart === "datadog")!;
      const holders = g.edges.filter((e) => e.to === datadog.id).map((e) => e.from.split("/")[0]);
      expect(holders.sort()).toEqual(["argo", "argo", "k8s-dd", "k8s-dd", "tf"]);

      // One values node for each member that reads the file, and each holder reaches the one in its own member.
      const values = g.nodes.filter((n) => n.kind === "Helm::Values");
      expect(values.map((v) => v.id).sort()).toEqual(["argo/argo/values/k8s/dd/values.yaml", "k8s-dd/k8s-dd/values/k8s/dd/values.yaml"]);
      expect(g.ambiguous ?? []).toEqual([]);
      expect(g.edges.filter((e) => values.some((v) => v.id === e.to)).map((e) => [e.from, e.to].map((id) => id.split("/")[0]))).toEqual([
        ["argo", "argo"],
        ["k8s-dd", "k8s-dd"],
      ]);

      const missing = g.dangling ?? [];
      expect(missing.map((d) => [d.from, d.value, d.targetKind])).toEqual([["k8s-gone/k8s-gone/kustomizationK8sGone", "k8s/gone/missing.yaml", "Helm::Values"]]);
    },
    TIMEOUT,
  );
  test(
    "an Application in a namespace reaches both its destination cluster Secret in that namespace and the values file in its own member",
    async () => {
      const g = await read({
        "argo/clusters.yaml":
          "apiVersion: v1\nkind: Secret\nmetadata:\n  name: cluster-prod\n  namespace: argocd\n  labels:\n    argocd.argoproj.io/secret-type: cluster\nstringData:\n  name: prod\n  server: https://10.0.0.1\n",
        "argo/app.yaml":
          "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: dd\n  namespace: argocd\nspec:\n  project: default\n  sources:\n    - repoURL: https://helm.datadoghq.com\n      chart: datadog\n      targetRevision: 3.244.0\n      helm:\n        valueFiles:\n          - $values/k8s/dd/values.yaml\n    - repoURL: https://example.com/repo.git\n      ref: values\n  destination:\n    name: prod\n    namespace: dd\n",
        "k8s/dd/values.yaml": "datadog:\n  site: datadoghq.com\n",
      });
      const from = "argo/argo/applicationDd";
      const to = g.edges.filter((e) => e.from === from).map((e) => [e.to, e.rule]);
      expect(to).toContainEqual(["argo/argo/secretClusterProd", "k8s:K8s::Argo::Application:spec.destination.name"]);
      expect(to).toContainEqual(["argo/argo/values/k8s/dd/values.yaml", "k8s:K8s::Argo::Application:helmReferences.valuesFiles[]"]);
      // Nothing names a cluster resource or a Namespace here, so those two references dangle; the values file does not.
      expect((g.dangling ?? []).map((d) => d.targetKind).sort()).toEqual(["K8s::Core::Namespace", "azurerm_kubernetes_cluster"]);
      expect(g.ambiguous ?? []).toEqual([]);
    },
    TIMEOUT,
  );
});
