import { ConfigMap } from "@intentius/chant-lexicon-k8s";
import { sharedLabels } from "./taint-shared-config";

/**
 * Taint sub-graph, node 3 of 4 — the capturer, and the reason this entry
 * exists at all.
 *
 * Decision point: **L8.7 / F-Succ backward** — a file whose objects were
 * captured taints the file that captured them. This is the REVERSE edge, and
 * it is the half of `planFoldTaint` no corpus entry was built to fire before
 * chant #2347: forward and backward taint only ever run across a fold/run
 * boundary inside one build, so a corpus of fully-folding entries exercises
 * neither, and #2345's mixed entries exercise the forward half by accident at
 * best.
 *
 * Follow the edges. This file folds cleanly on its own, and while folding it
 * it captures `sharedLabels` — a non-primitive, so it has identity and
 * `liveSources` records `taint-shared-config.ts` against this file (L8.5,
 * L5.12). Nothing about this file is wrong. But `taint-shared-config.ts` is
 * itself forced to run (forward taint from `taint-run-only-importer.ts`), and
 * a folded file holding an object that its source is about to rebuild by
 * running is the "Logical name not set" class of crash arriving from the far
 * side. So the reverse edge fires and this file runs too.
 *
 * Note which edge does it. This file also IMPORTS `taint-shared-config.ts`,
 * and that forward edge points the other way — from importer to imported — so
 * it cannot carry taint back here. Strike `liveSources` out of the
 * `planFoldTaint` call in `packages/core/src/discovery/index.ts` and this file
 * folds while its source runs; nothing else in the corpus changes. That is the
 * tamper `fold-adversarial.test.ts`'s split assertion is written against.
 */
export const capturingSibling = new ConfigMap({
  metadata: { name: "taint-capturing-sibling", labels: sharedLabels },
  data: { role: "folds in isolation; reverse taint puts it on the run path" },
});
