import { describe, expect, test } from "vitest";
import type { IRNode } from "@intentius/chant/graph-ir";
import { generateApplications } from "./application-set";
import { applicationPathRules } from "./application-paths";

const secret = (name: string, labels: Record<string, string>, server = `https://${name}.example.com`): IRNode => ({
  id: `argo/secret-${name}`,
  kind: "K8s::Core::Secret",
  lexicon: "k8s",
  attrs: { metadata: { name, labels: { "argocd.argoproj.io/secret-type": "cluster", ...labels } }, argoCluster: { name, server } },
});

const appSet = (spec: Record<string, unknown>, namespace?: string): IRNode => ({
  id: "apps/set",
  kind: "K8s::Argo::ApplicationSet",
  lexicon: "k8s",
  attrs: { apiVersion: "argoproj.io/v1alpha1", kind: "ApplicationSet", metadata: { name: "set", ...(namespace ? { namespace } : {}) }, spec },
});

const template = (name: string, path: string, server = "{{ .server }}") => ({ metadata: { name, namespace: "ignored" }, spec: { source: { repoURL: "https://example.com/r.git", path }, destination: { server } } });

const CLUSTERS = [secret("gke-a", { cloud: "gke", env: "prod" }), secret("gke-b", { cloud: "gke", env: "dev" }), secret("eks-a", { cloud: "eks", env: "prod" })];

describe("generateApplications (#5102)", () => {
  test("matchExpressions select clusters, and the Go form reads labels and values", () => {
    const set = appSet(
      {
        goTemplate: true,
        generators: [
          {
            clusters: {
              selector: { matchExpressions: [{ key: "env", operator: "In", values: ["prod"] }, { key: "cloud", operator: "NotIn", values: ["eks"] }] },
              values: { dir: "envs/{{ .metadata.labels.env }}" },
            },
          },
        ],
        template: template("x-{{ .name }}", "{{ .values.dir }}/{{ index .metadata.labels \"cloud\" }}"),
      },
      "argocd",
    );
    const out = generateApplications(set, CLUSTERS);
    expect(out.notExpanded).toEqual([]);
    expect(out.nodes.map((n) => [n.key, (n.attrs.spec as { source: { path: string } }).source.path, n.cluster?.id])).toEqual([["x-gke-a", "envs/prod/gke", "argo/secret-gke-a"]]);
    expect((out.nodes[0].attrs.metadata as { namespace: string }).namespace).toBe("argocd");
    expect(out.nodes[0].params).toMatchObject({ "values.dir": "envs/prod", nameNormalized: "gke-a" });
  });

  test("a clusters generator with no selector also yields in-cluster when no Secret registers it", () => {
    const out = generateApplications(appSet({ goTemplate: true, generators: [{ clusters: {} }], template: template("x-{{ .name }}", "p") }), CLUSTERS);
    expect(out.nodes.map((n) => n.key)).toEqual(["x-eks-a", "x-gke-a", "x-gke-b", "x-in-cluster"]);
    expect(out.nodes.find((n) => n.key === "x-in-cluster")?.cluster).toBeUndefined();
    const registered = generateApplications(appSet({ goTemplate: true, generators: [{ clusters: {} }], template: template("x-{{ .name }}", "p") }), [secret("local", {}, "https://kubernetes.default.svc")]);
    expect(registered.nodes.map((n) => n.key)).toEqual(["x-local"]);
  });

  test("the default form substitutes flattened list parameters, and a generator's template is merged over the set's", () => {
    const out = generateApplications(
      appSet({
        generators: [{ list: { elements: [{ app: "a", values: { tier: "web" } }], template: { spec: { destination: { name: "c1" } } } } }],
        template: template("{{app}}-{{ values.tier }}", "apps/{{app}}", "https://x"),
      }),
      [],
    );
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].key).toBe("a-web");
    expect(out.nodes[0].attrs.spec).toEqual({ source: { repoURL: "https://example.com/r.git", path: "apps/a" }, destination: { server: "https://x", name: "c1" } });
  });

  test("an unknown function or field is reported and that element is not expanded", () => {
    const out = generateApplications(
      appSet({ goTemplate: true, generators: [{ list: { elements: [{ name: "a" }, { name: "b", path: "q" }] } }], template: template("{{ .name | upper }}", "p") }),
      [],
    );
    expect(out.nodes).toEqual([]);
    expect(out.notExpanded).toEqual([
      "generators[0] element 0: {{ .name | upper }} uses a function or form the graph does not expand; not expanded",
      "generators[0] element 1: {{ .name | upper }} uses a function or form the graph does not expand; not expanded",
    ]);
    const missing = generateApplications(appSet({ goTemplate: true, generators: [{ list: { elements: [{ name: "a" }] } }], template: template("{{ .name }}", "{{ .path }}") }), []);
    expect(missing.notExpanded).toEqual(["generators[0] element 0: the parameters have no .path; not expanded"]);
  });

  test("other generators, a post-selector and templatePatch are noted as not expanded", () => {
    const out = generateApplications(
      appSet({
        generators: [{ git: { repoURL: "r" } }, { matrix: { generators: [] } }, { list: { elements: [] }, selector: { matchLabels: { a: "b" } } }, { list: { elementsYaml: "{{ .x }}" } }],
        template: template("n", "p"),
      }),
      [],
    );
    expect(out.notExpanded).toEqual([
      "generators[0]: the git generator is not expanded",
      "generators[1]: the matrix generator is not expanded",
      "generators[2]: a generator's post-selector is not expanded",
      "generators[3]: list elementsYaml is not expanded",
    ]);
    expect(generateApplications(appSet({ templatePatch: "x", generators: [{ list: { elements: [{}] } }], template: template("n", "p") }), []).notExpanded).toEqual([
      "templatePatch is not expanded, so no Application is generated",
    ]);
  });
});

describe("applicationPathRules (#5102)", () => {
  const app = (spec: Record<string, unknown>): IRNode => ({ id: "a", kind: "K8s::Argo::Application", lexicon: "k8s", attrs: { spec } });
  const read = (n: IRNode) => Object.fromEntries(applicationPathRules.map((r) => [r.path, r.read(n)]).filter(([, v]) => (v as unknown[]).length > 0));

  test("a single source's path and its value files inside it", () => {
    expect(read(app({ source: { repoURL: "R", path: "./apps/web/", helm: { valueFiles: ["values.yaml", "https://x/v.yaml"] } } }))).toEqual({
      "spec.source.path": [{ value: "apps/web", repo: "R", type: "dir" }],
      "spec.source.helm.valueFiles[]": [{ value: "apps/web/values.yaml", repo: "R", type: "file" }],
    });
  });

  test("a chart source's $values file is read in the repository of the source with that ref", () => {
    expect(
      read(app({ sources: [{ repoURL: "https://charts", chart: "c", helm: { valueFiles: ["$values/k/helm/c.yaml", "inside-chart.yaml"] } }, { repoURL: "R", ref: "values" }] })),
    ).toEqual({ "spec.sources[].helm.valueFiles[]": [{ value: "k/helm/c.yaml", repo: "R", type: "file" }] });
  });

  test("ignoreMissingValueFiles, an absolute path and an escape are not read", () => {
    expect(read(app({ source: { repoURL: "R", path: "../up", helm: { ignoreMissingValueFiles: true, valueFiles: ["v.yaml"] } } }))).toEqual({});
    expect(read(app({ source: { repoURL: "R", path: "/abs" } }))).toEqual({});
  });
});
