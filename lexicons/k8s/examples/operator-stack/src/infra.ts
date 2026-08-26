// OperatorStack (#1940): the operating loop itself, declared as a k8s
// estate — a Namespace, one CronJob per ConvergeOp, and RBAC scoped to what
// each hosted tick can actually do. Two hosts here: a read-only observer
// (no dispatch targets — read-only RBAC) and an apply-dial loop whose one
// dispatch target is a mutating op (kubectlApply-shaped — no deleteMode, so
// mutating, never destructive), which elevates only its own RBAC to
// create/update/patch.

import { OperatorStack } from "@intentius/chant-lexicon-k8s";
import type { OpConfig } from "@intentius/chant/op";

const fountainApplyOp: Pick<OpConfig, "phases" | "onFailure"> = {
  phases: [{ name: "apply", steps: [{ kind: "activity", fn: "kubectlApply" }] }],
};

export const operator = OperatorStack({
  name: "chant-operator",
  image: "ghcr.io/intentius/chant:0.49.0",
  converge: [
    {
      name: "fountain-observe",
      schedule: "*/10 * * * *",
      env: "staging",
      dial: "observe",
    },
    {
      name: "fountain-apply",
      schedule: "*/10 * * * *",
      env: "staging",
      dial: "apply",
      dispatchTargets: [fountainApplyOp],
    },
  ],
});
