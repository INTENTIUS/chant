import { ConfigMap } from "@intentius/chant-lexicon-k8s";

/**
 * Taint sub-graph, node 4 of 4 — the control.
 *
 * Decision point: **L8.8 / F-Taint, F-Fix** — the fixpoint is a reachability
 * walk over two edge sets, not a per-build verdict. This file imports no
 * sibling and captures nothing, so no edge reaches it and it folds while three
 * files beside it run.
 *
 * Without it, "the taint made those three run" is indistinguishable from "this
 * entry does not fold", which is the failure mode the whole entry is meant to
 * avoid: a green differential that never stressed anything. Its labels are a
 * local copy of `taint-shared-config.ts`'s on purpose — the same VALUE, no
 * shared identity — because L8.5 taints on identity, not equality, and a file
 * that merely agrees with a tainted one about a string has nothing to
 * disagree about later.
 */
const localLabels = {
  "app.kubernetes.io/part-of": "fold-adversarial",
  "chant.dev/fixture": "taint-independent",
};

export const independent = new ConfigMap({
  metadata: { name: "taint-independent", labels: localLabels },
  data: { role: "no edge reaches it; it folds" },
});
