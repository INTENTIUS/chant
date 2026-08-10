import { describe, test, expect } from "vitest";
import { namespaceSegmentForGroup } from "./group-namespace";
import { renderedManifestEntity } from "./kustomize/rendered-entity";
import { K8sParser } from "./import/parser";

describe("namespaceSegmentForGroup", () => {
  test("the empty core group is Core", () => {
    expect(namespaceSegmentForGroup("")).toBe("Core");
  });

  test("a single-segment group PascalCases", () => {
    expect(namespaceSegmentForGroup("apps")).toBe("Apps");
  });

  test("only the first dot-segment counts", () => {
    expect(namespaceSegmentForGroup("rbac.authorization.k8s.io")).toBe("Rbac");
  });

  test("a hyphenated first segment kebab→Pascals", () => {
    expect(namespaceSegmentForGroup("cert-manager.io")).toBe("CertManager");
  });

  test("argoproj.io takes the Argo override", () => {
    expect(namespaceSegmentForGroup("argoproj.io")).toBe("Argo");
  });

  test("the toolkit groups collapse to Flux", () => {
    expect(namespaceSegmentForGroup("kustomize.toolkit.fluxcd.io")).toBe("Flux");
  });
});

// #1628: rendered and imported entityTypes used to bypass the overrides, so a
// Flux CR arriving through a kustomize root or `chant import` was typed to a
// name that matches nothing in operations.json.
describe("the shared rule reaches the render and import paths", () => {
  test("a rendered Flux Kustomization is typed K8s::Flux::Kustomization", () => {
    const entity = renderedManifestEntity(
      {
        apiVersion: "kustomize.toolkit.fluxcd.io/v1",
        kind: "Kustomization",
        metadata: { name: "apps", namespace: "flux-system" },
        spec: { path: "./apps/prod", prune: true },
      },
      "clusters/prod",
    );

    expect(entity?.entityType).toBe("K8s::Flux::Kustomization");
  });

  test("an imported Argo Application is typed K8s::Argo::Application", () => {
    const ir = new K8sParser().parse(`
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: guestbook
  namespace: argocd
spec:
  project: default
`);

    expect(ir.resources.length).toBe(1);
    expect(ir.resources[0].type).toBe("K8s::Argo::Application");
  });
});
