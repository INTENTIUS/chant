import { ConfigMap } from "@intentius/chant-lexicon-k8s";

/**
 * Decision point: **L3.4 / F-Div-SpreadType** — an object spread whose source
 * folds to something that is not an object.
 *
 * `subset.ts` names this as the third of its inherently environment-dependent
 * divergences: `{ ...replicaCount }` is shape-valid, because `replicaCount` is
 * a plain identifier and shape is all the classifier looks at. Only evaluation
 * discovers it is a number, and `fold()` then rejects rather than guessing.
 *
 * JavaScript does not throw here — `{ ...3 }` is `{}`, a number has no own
 * enumerable properties — so the interesting question is not error parity but
 * whether the fold path invents a value on the way past. It does not: the file
 * falls back to run, the run spreads the number to nothing, and the ConfigMap
 * carries only `mode`. A fold that had "helpfully" treated the number as an
 * empty object would produce the same bytes here by luck and a different set
 * the moment the source were a string (`{ ..."ab" }` is `{ 0: "a", 1: "b" }`),
 * which is exactly the kind of near-miss this corpus exists to keep out.
 *
 * Differential mode: **byte-identical output**, with the file falling back to
 * run rather than folding.
 */
// The cast is the fixture. TypeScript refuses `{ ...3 }` outright (TS2698), so
// a spread whose source turns out not to be an object can only reach `fold()`
// through a type the compiler believed and evaluation contradicts — which is
// the point: this divergence is invisible to every layer above resolution.
const replicaCount = 3 as unknown as Record<string, string>;

export const spreadNonObject = new ConfigMap({
  metadata: { name: "spread-non-object" },
  data: { ...replicaCount, mode: "adversarial" },
});
