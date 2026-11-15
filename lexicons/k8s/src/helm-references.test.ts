import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Declarable } from "@intentius/chant/declarable";
import { generatedValuesNodes, helmChartKey, kustomizationDocument, readHelmReferences, stampGeneratedApplication, stampHelmReferences } from "./helm-references";

const dirs: string[] = [];
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "chant-helm-refs-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const app = (spec: Record<string, unknown>, kind = "Application") => ({ apiVersion: "argoproj.io/v1alpha1", kind, metadata: { name: "a" }, spec });

describe("stampHelmReferences", () => {
  test("an Argo source with a chart names the chart, and $values resolves from the workspace root", () => {
    const root = workspace({});
    const { references } = stampHelmReferences(
      app({
        sources: [
          { repoURL: "https://charts.example.com/", chart: "web", targetRevision: "1.2.3", helm: { valueFiles: ["$values/envs/prod/web.yaml", "relative-in-chart.yaml"] } },
          { repoURL: "https://example.com/repo.git", ref: "values" },
        ],
      }),
      { workspace: root, dir: join(root, "argo") },
    );
    expect(references).toEqual({
      charts: [{ repo: "https://charts.example.com", chart: "web", version: "1.2.3", valuesFiles: ["envs/prod/web.yaml"] }],
      valuesFiles: ["envs/prod/web.yaml"],
    });
  });

  test("an ApplicationSet is read through its template; a templated path or chart is not read", () => {
    const root = workspace({});
    const set = app(
      { template: { spec: { source: { repoURL: "https://charts.example.com", chart: "web", targetRevision: "2.0.0", helm: { valueFiles: ["$values/{{ .name }}/web.yaml"] } } } } },
      "ApplicationSet",
    );
    expect(stampHelmReferences(set, { workspace: root, dir: root }).references?.charts).toEqual([{ repo: "https://charts.example.com", chart: "web", version: "2.0.0" }]);
    const named = app({ source: { repoURL: "https://charts.example.com", chart: "{{ .chart }}" } }, "ApplicationSet");
    expect(stampHelmReferences(named, { workspace: root, dir: root }).references).toBeUndefined();
  });

  test("a values path that leaves the workspace stays in the stamp as written, so it is dangling", () => {
    const root = workspace({});
    const { references } = stampHelmReferences(
      { apiVersion: "kustomize.config.k8s.io/v1beta1", kind: "Kustomization", helmCharts: [{ name: "c", repo: "https://r.example.com", valuesFile: "../../../outside.yaml" }] },
      { workspace: root, dir: join(root, "a", "b") },
    );
    expect(references?.valuesFiles).toEqual(["../../../outside.yaml"]);
  });

  test("a Flux HelmRelease names its HelmRepository until the catalog resolves it", () => {
    const root = workspace({});
    const { references } = stampHelmReferences(
      { apiVersion: "helm.toolkit.fluxcd.io/v2", kind: "HelmRelease", metadata: { name: "r", namespace: "apps" }, spec: { chart: { spec: { chart: "web", version: "1.x", sourceRef: { kind: "HelmRepository", name: "repo" } } } } },
      { workspace: root, dir: root },
    );
    expect(references?.charts).toEqual([{ repo: "flux:apps/repo", chart: "web", version: "1.x" }]);
  });

  test("an object that names no chart is returned as it is", () => {
    const doc = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "x" } };
    expect(stampHelmReferences(doc, { workspace: "/w", dir: "/w" })).toEqual({ doc });
  });
});

describe("kustomizationDocument", () => {
  test("is the kustomization with its defaults and the member's name, only when it has helmCharts", () => {
    const root = workspace({
      "with/kustomization.yaml": "helmCharts:\n  - name: c\n    repo: https://r.example.com\n    version: 1.0.0\n",
      "without/kustomization.yaml": "resources:\n  - a.yaml\n",
    });
    expect(kustomizationDocument(join(root, "with"), "with")).toMatchObject({ apiVersion: "kustomize.config.k8s.io/v1beta1", kind: "Kustomization", metadata: { name: "with" } });
    expect(kustomizationDocument(join(root, "without"), "without")).toBeUndefined();
  });
});

describe("readHelmReferences", () => {
  test("a values file that exists is a node with its charts, its extraObjects are manifest nodes, and one that does not exist is no node", () => {
    const root = workspace({
      "a/values.yaml": "extraObjects:\n  - apiVersion: v1\n    kind: ConfigMap\n    metadata:\n      name: from-values\n  - not-a-mapping\n",
      "a/broken.yaml": "key: [unclosed\n",
    });
    const entities = new Map<string, Declarable>();
    const warnings: string[] = [];
    const doc = { apiVersion: "kustomize.config.k8s.io/v1beta1", kind: "Kustomization", helmCharts: [{ name: "c", repo: "https://r.example.com", version: "1", valuesFile: "values.yaml" }, { name: "d", repo: "https://r.example.com", valuesFile: "gone.yaml" }, { name: "e", repo: "https://r.example.com", valuesFile: "broken.yaml" }] };
    const out = readHelmReferences({ documents: [doc], ctx: { workspace: root, dir: join(root, "a") }, label: "a", entities, warnings, memberKind: "kustomize" });
    expect((out[0] as { helmReferences: { valuesFiles: string[] } }).helmReferences.valuesFiles).toEqual(["a/broken.yaml", "a/gone.yaml", "a/values.yaml"]);
    expect([...entities.keys()].sort()).toEqual(["a/configMapFromValues", "a/values/a/values.yaml"]);
    const values = entities.get("a/values/a/values.yaml")!;
    expect(values.entityType).toBe("Helm::Values");
    expect((values as unknown as { props: { charts: unknown } }).props.charts).toEqual([{ repo: "https://r.example.com", chart: "c", version: "1" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("a/broken.yaml");
  });
});

test("helmChartKey drops the scheme and ends at the version", () => {
  expect(helmChartKey({ repo: "https://h.example.com", chart: "c", version: "1" })).toBe("h.example.com/c@1");
});

describe("a generated Application (#5094)", () => {
  const generated = stampGeneratedApplication(
    app({
      sources: [
        { repoURL: "https://charts.example.com", chart: "eso", targetRevision: "2.0.0", helm: { valueFiles: ["$values/clusters/a/eso.yaml", "$values/../outside.yaml"] } },
        { repoURL: "https://example.com/repo.git", path: "clusters/a/app", helm: { valueFiles: ["local.yaml"] } },
        { repoURL: "https://example.com/repo.git", ref: "values" },
      ],
    }),
  );

  test("gets the stamp the reader gives one written by hand, with no directory read", () => {
    expect(generated.helmReferences).toEqual({
      charts: [{ repo: "https://charts.example.com", chart: "eso", version: "2.0.0", valuesFiles: ["clusters/a/eso.yaml"] }],
      valuesFiles: ["clusters/a/app/local.yaml", "clusters/a/eso.yaml", "$values/../outside.yaml"],
    });
  });

  test("its values files that exist are Helm::Values nodes with their extraObjects, and one its member holds is not read again", () => {
    const files: Record<string, string> = {
      "clusters/a/eso.yaml": "extraObjects:\n  - apiVersion: external-secrets.io/v1\n    kind: ClusterSecretStore\n    metadata:\n      name: s\n  - apiVersion: external-secrets.io/v1\n    kind: ClusterSecretStore\n    metadata:\n      name: s\n",
      "clusters/a/app/local.yaml": "a: 1\n",
    };
    const reads: string[] = [];
    const readFile = (p: string) => (reads.push(p), files[p]);
    const node = { id: "m/m/applicationSetX/a", kind: "K8s::Argo::Application", lexicon: "k8s", member: "m", attrs: generated } as never;
    const held = { id: "m/m/values/clusters/a/app/local.yaml", kind: "Helm::Values", lexicon: "helm", member: "m", attrs: { path: "clusters/a/app/local.yaml" } } as never;
    const out = generatedValuesNodes(node, readFile, [held]);
    expect(out.map((f) => [f.key, f.kind, f.lexicon])).toEqual([
      ["values/clusters/a/eso.yaml", "Helm::Values", "helm"],
      ["values/clusters/a/eso.yaml/clusterSecretStoreS", "K8s::ExternalSecrets::ClusterSecretStore", "k8s"],
      ["values/clusters/a/eso.yaml/clusterSecretStoreS~2", "K8s::ExternalSecrets::ClusterSecretStore", "k8s"],
    ]);
    expect(out[0]!.attrs).toMatchObject({ path: "clusters/a/eso.yaml", charts: [{ repo: "https://charts.example.com", chart: "eso", version: "2.0.0" }] });
    expect((out[1]!.attrs.metadata as { annotations: Record<string, string> }).annotations["chant.intentius.io/helm-values"]).toBe("clusters/a/eso.yaml");
    expect(reads).toEqual(["clusters/a/eso.yaml"]);
  });
});
