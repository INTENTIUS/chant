import { ConfigMap } from "@intentius/chant-lexicon-k8s";

/**
 * Taint sub-graph, node 1 of 4 — the shared source.
 *
 * Decision point: **L8.6 / F-Succ forward** — the importer of a non-folding
 * file taints what it imports.
 *
 * Nothing in this file resists folding. It exports a plain object with
 * identity (`sharedLabels`) and a ConfigMap built from it, and folded on its
 * own it would report `[fold:fold]`. It is forced to run anyway, because
 * `taint-run-only-importer.ts` imports `sharedLabels` and cannot fold: were
 * this file folded independently, the importer's real re-import would build a
 * SECOND `sharedLabels` object and a second ConfigMap, and the two copies
 * would be different objects claiming to be the same entity.
 *
 * Its fold decision therefore carries `reverseTainted: true` — the flag
 * `discover()` sets for a file whose own fold attempt succeeded and which the
 * fixpoint overruled — and the reason "would fold in isolation, but a file
 * that imports it (directly or transitively) falls back to run". That pair is
 * what `fold-adversarial.test.ts` asserts, and it is the only way to tell this
 * file apart from one that simply could not fold.
 */
export const sharedLabels = {
  "app.kubernetes.io/part-of": "fold-adversarial",
  "chant.dev/fixture": "taint-shared-config",
};

export const sharedConfig = new ConfigMap({
  metadata: { name: "taint-shared-config", labels: sharedLabels },
  data: { role: "shared source of a live object" },
});
