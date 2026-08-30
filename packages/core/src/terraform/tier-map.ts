/**
 * Terraform-type → native-spec ranking for the carve-out advisor (#214 T3),
 * resolved through the carve provider registry (`carve-provider.ts`, #2016).
 *
 * Every entry comes from a registered provider: the AWS ones from the single
 * AWS carve-out table (`providers/aws.ts` over `aws-resources.ts`), so the
 * advisor ranks exactly the AWS types `carve emit` can produce — no advise↔emit
 * cliff — and the Kubernetes ones from `providers/kubernetes.ts`, which ranks
 * but does not yet emit.
 *
 *   tier 1 — a clean 1:1 native resource
 *   tier 2 — maps, but with reshaping
 *   tier 3 — a hard/partial map
 *   null   — no known native mapping (unsupported provider/type) → score 0
 *
 * These are functions, not frozen constants: the registry is open, so a
 * provider registered after module load has to be visible here.
 */

import {
  carveFoldParent,
  carveIdentityAttr,
  carveTierMap,
  resolveEmitProvider,
  type TierInfo,
} from "./carve-provider";

export { carveEmitTypes, type TierInfo } from "./carve-provider";

/** TF resource type → native tier, over every registered provider. Absent = unsupported (score 0). */
export function tierMap(): Readonly<Record<string, TierInfo>> {
  return carveTierMap();
}

export function resolveTier(tfType: string): TierInfo | null {
  return carveTierMap()[tfType] ?? null;
}

/**
 * The HCL attribute carrying a resource's physical name. A dotted entry is a
 * path into nested blocks (`manifest.metadata.name`). Used for the graph's
 * identity and the live-import hint. Absent → fall back to the TF logical name.
 */
export function identityAttrOf(tfType: string): string | undefined {
  return carveIdentityAttr(tfType);
}

/**
 * The parent Terraform type a sub-resource folds into, if any. Terraform splits
 * configuration the native spec keeps in one resource; a sub-resource sharing
 * its parent's name carves with the parent rather than being ranked on its own.
 */
export function foldParentOf(tfType: string): string | undefined {
  return carveFoldParent(tfType);
}

/**
 * Can `chant carve emit` produce chant source for this type? Narrower than
 * `resolveTier`: providers also rank types no emit path can adopt (the
 * kubernetes ones, #999). Both emit paths — `--state` and `--env` — gate on
 * this, so a type either command refuses is refused by the other with the same
 * message.
 */
export function canCarveEmit(tfType: string): boolean {
  return resolveEmitProvider(tfType) !== undefined;
}

/**
 * Can `chant carve bridge` render a Terraform `data` source for this type? A
 * dotted identity attribute is a path into nested blocks, and a data source
 * body is flat `attr = value` — `manifest.metadata.name = "x"` is not valid
 * HCL. An absent entry is fine: the bridge writes a TODO comment instead.
 */
export function canBridge(tfType: string): boolean {
  const attr = carveIdentityAttr(tfType);
  return attr === undefined || !attr.includes(".");
}
