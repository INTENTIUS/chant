import { ConfigMap } from "@intentius/chant-lexicon-k8s";

/**
 * Decision point: **L3.21 / F-Eval-Member steps 3-4** — `?.` on a nullish
 * object, and the short-circuit marker that carries the rest of the chain
 * (chant #2328's other half).
 *
 * The sibling of `nullish-property-read.ts`, and the reason that file's
 * refusal is a refusal rather than a ban on reading through anything that
 * might be absent. `optional.missing?.vpcId` is `undefined` in JavaScript by
 * definition, so `fold()` answers `undefined` too and the file folds; the
 * chained `optional.missing?.deep.vpcId` is `undefined` as well, because every
 * link after a short-circuit short-circuits — NOT a `TypeError` on
 * `undefined.deep`, which is what a naive "answer `undefined` and carry on"
 * would produce at the second link. `optional.net?.deep.vpcId` is the control:
 * same shape, non-nullish object, so the chain runs to its end and yields a
 * real string.
 *
 * All four reads land in a template span, so the folded value is stringified
 * exactly as `String(undefined)` stringifies it on the run path. If the two
 * paths disagreed about which links short-circuit, the rendered ConfigMap
 * would say so in its data.
 *
 * Differential mode: **byte-identical output**, and the file folds.
 */
interface Layer {
  vpcId: string;
  deep: { vpcId: string };
}

interface Layers {
  net?: Layer;
  missing?: Layer;
}

const optional: Layers = {
  net: { vpcId: "vpc-0adversarial", deep: { vpcId: "vpc-0deep" } },
};

export const optionalChain = new ConfigMap({
  metadata: { name: "optional-chain-short-circuit" },
  data: {
    present: `${optional.net?.vpcId}`,
    presentChained: `${optional.net?.deep.vpcId}`,
    absent: `${optional.missing?.vpcId}`,
    chainedPastShortCircuit: `${optional.missing?.deep.vpcId}`,
  },
});
