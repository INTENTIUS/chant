import { ConfigMap } from "@intentius/chant-lexicon-k8s";

/**
 * Decision point: **L3.10 / F-Div-Nullish** — a property read whose object
 * resolves to `null`/`undefined` (chant #2328).
 *
 * `layers["nett"]` is a typo. TypeScript is happy with it (an index signature
 * hands back the value type, not `T | undefined`, without
 * `noUncheckedIndexedAccess`), so nothing before resolution can see the
 * mistake: `subset.ts` classifies `missingLayer.vpcId` as shape-valid, because
 * what the object resolves to is exactly the resolution the shape classifier
 * does not do.
 *
 * Running throws `TypeError: Cannot read properties of undefined (reading
 * 'vpcId')`. Before #2328 `fold()` answered `undefined` and the build carried
 * on with the key dropped — a fold/run disagreement with no syntactic tell.
 * It now refuses, this file falls back to run, and the run throws.
 *
 * So this fixture's differential mode is **error parity**, not byte-identical
 * output: both paths produce the same `DiscoveryError` for this file, and the
 * fold path produces no value for it at all. Revert the two `nullishAccess`
 * throws in `packages/core/src/fold/fold.ts` and the fold side starts
 * answering where the run side throws — the differential goes red on the
 * error comparison, which is the check #2328 was found by.
 */
const layers: Record<string, { vpcId: string }> = {
  net: { vpcId: "vpc-0adversarial" },
};

const missingLayer = layers["nett"];

export const nullishRead = new ConfigMap({
  metadata: { name: "nullish-property-read" },
  data: { vpcId: missingLayer.vpcId },
});
