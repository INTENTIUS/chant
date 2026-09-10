import { ConfigMap } from "@intentius/chant-lexicon-k8s";
import { sharedLabels } from "./taint-shared-config";

/**
 * Taint sub-graph, node 2 of 4 — the seed.
 *
 * Decision point: **L5.4 / S-FnBody** — a project-local function whose body is
 * not "one expression, or `const`s then a final `return`". `tier` takes an
 * early return, which is on that rule's explicit exclusion list, so the call
 * cannot fold and the whole file falls back to run (L8.2, all-or-nothing per
 * file).
 *
 * The early return is deliberately ordinary code. The point of this file is
 * not its own rejection — `fold.test.ts` covers that — but that it is the SEED
 * of the fixpoint: it is the one file here whose own fold attempt fails, and
 * every other run decision in the sub-graph is derived from this one by
 * `planFoldTaint` walking edges. Its decision carries `reverseTainted: false`,
 * because the flag marks a file the fixpoint overruled, and this file was
 * never in a position to be overruled.
 *
 * Its import of `sharedLabels` is the forward edge that carries the taint into
 * `taint-shared-config.ts`.
 */
function tier(replicas: number): string {
  if (replicas > 1) return "ha";
  return "single";
}

export const runOnlyImporter = new ConfigMap({
  metadata: { name: "taint-run-only-importer", labels: sharedLabels },
  data: { tier: tier(2) },
});
