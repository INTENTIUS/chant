/**
 * Terraform-type → native-spec ranking for the carve-out advisor (#214 T3),
 * resolved through the carve provider registry (`carve-provider.ts`, #2016).
 *
 * Every entry comes from a registered provider: the AWS ones from the single
 * AWS carve-out table (`providers/aws.ts` over `aws-resources.ts`), so the
 * advisor ranks exactly the AWS types `carve emit` can produce — no advise↔emit
 * cliff — and the Kubernetes ones from `providers/kubernetes.ts`, which emits
 * `kubernetes_manifest` and ranks the typed provider resources it does not.
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
  carveDataSourceShape,
  carveFoldParent,
  carveIdentityAttr,
  carveTierMap,
  resolveEmitProvider,
  type TierInfo,
} from "./carve-provider";
import type { DataSourceShape } from "./data-source-shape";

export { carveEmitTypes, type TierInfo } from "./carve-provider";
export type { DataSourceShape } from "./data-source-shape";

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
 * `resolveTier`: providers also rank types no emit path can adopt (the typed
 * `kubernetes_*` resources, whose manifest only the provider schema knows how
 * to reassemble). Both emit paths — `--state` and `--env` — gate on this, so a
 * type either command refuses is refused by the other with the same message.
 */
export function canCarveEmit(tfType: string): boolean {
  return resolveEmitProvider(tfType) !== undefined;
}

/**
 * How `chant carve bridge` reads this type back as a `data` source: the
 * data-source type, where each argument comes from in the carved body, and how
 * a survivor's attribute path translates (#2034). Undefined when the type
 * cannot be read back at all.
 */
export function dataSourceShapeOf(tfType: string): DataSourceShape | undefined {
  return carveDataSourceShape(tfType);
}

/**
 * Can `chant carve bridge` render a Terraform `data` source for this type?
 * True whenever its provider contributes a shape — declared, or implied by a
 * plain identity attribute. False for a dotted identity attribute with no
 * declared shape: that is a path into nested values, and a flat `attr = value`
 * body cannot express it (`manifest.metadata.name = "x"` is not valid HCL). A
 * type with no identity attribute at all still bridges; the bridge writes a
 * TODO comment for the body.
 */
export function canBridge(tfType: string): boolean {
  return carveDataSourceShape(tfType) !== undefined;
}
