import { describe, test, expect } from "vitest";
import { deployUnits } from "./deploy-units";
import type { Phase } from "./component";

const phase = (name: string, steps: Phase["steps"]): Phase => ({ phase: name, steps });

describe("deployUnits (#1495 piece 1)", () => {
  test("resolves a cfn-deploy step to its stack, keyed to the aws observer", () => {
    const deploy = [phase("Apply", [{ kind: "cfn-deploy", stack: "cc-canonical", template: "t.json" }])];
    expect(deployUnits(deploy)).toEqual([{ unit: "cc-canonical", lexicon: "aws" }]);
  });

  test("resolves kubectl-apply and helm-upgrade units once their steps exist", () => {
    const deploy = [
      phase("Apply", [
        { kind: "kubectl-apply", stack: "kubemicrovm-ops" },
        { kind: "helm-upgrade", release: "operator" },
      ]),
    ];
    expect(deployUnits(deploy)).toEqual([
      { unit: "kubemicrovm-ops", lexicon: "k8s" },
      { unit: "operator", lexicon: "helm" },
    ]);
  });

  test("resolves the GitOps verbs to their stack — the CR is the unit (#1549 piece 2)", () => {
    const deploy = [
      phase("Apply", [
        { kind: "argo-app", manifest: "argo/app.yaml", stack: "gitops-argo" },
        { kind: "flux-reconcile", manifest: "flux/", stack: "gitops-flux" },
      ]),
    ];
    expect(deployUnits(deploy)).toEqual([
      { unit: "gitops-argo", lexicon: "k8s" },
      { unit: "gitops-flux", lexicon: "k8s" },
    ]);
  });

  test("walks nested phases, dedupes per lexicon, and skips unitless steps", () => {
    const deploy = [
      phase("Outer", [
        phase("Inner", [{ kind: "cfn-deploy", stack: "web" }]) as never,
        { kind: "cfn-deploy", stack: "web" },
        { kind: "shell", cmd: "echo", reason: "no capability yet" },
        { kind: "cfn-deploy" }, // no stack named — contributes nothing
      ]),
    ];
    expect(deployUnits(deploy)).toEqual([{ unit: "web", lexicon: "aws" }]);
  });

  test("an unlisted kind contributes no unit — the registry is the rule", () => {
    const deploy = [phase("Apply", [{ kind: "gcloud-deploy", stack: "x" }])];
    expect(deployUnits(deploy)).toEqual([]);
  });
});
