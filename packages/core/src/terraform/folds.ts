/**
 * Fold detection for the carve graph, shared by the scorer and the walks.
 *
 * A sub-resource whose type inlines into a parent (`foldParentOf`) carves with
 * that parent when the parent is in the estate under the same name:
 * `aws_s3_bucket_versioning.assets` goes with `aws_s3_bucket.assets`. The
 * scorer drops it from the ranking and discounts its edge to the parent; the
 * walks in `reach.ts` contract it into the parent before stepping, since an
 * uncontracted walk counts the child as a separate dependent (#2325 measured a
 * 100% overstatement on the sample estate). It lived privately in `score.ts`
 * until the walks needed it.
 */

import { foldParentOf } from "./tier-map";
import type { TfGraph } from "./types";

export interface Folds {
  /** Every address that folds into a parent present in the estate. */
  folded: Set<string>;
  /** Parent address → the addresses folded into it. */
  childrenOf: Map<string, Set<string>>;
}

/**
 * Build the set of addresses that fold into a parent present in the estate, plus
 * the reverse lookup (parent → its folded children), so a parent can discount
 * inbound edges coming from its own folded sub-resources.
 */
export function computeFolds(graph: TfGraph): Folds {
  const byAddress = new Map(graph.nodes.map((n) => [n.address, n]));
  const folded = new Set<string>();
  const childrenOf = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.kind !== "resource" || !node.type) continue;
    const parentType = foldParentOf(node.type);
    if (!parentType) continue;
    const parentAddress = `${parentType}.${node.name}`;
    if (!byAddress.has(parentAddress)) continue; // sub-resource without its parent → score it on its own
    folded.add(node.address);
    if (!childrenOf.has(parentAddress)) childrenOf.set(parentAddress, new Set());
    childrenOf.get(parentAddress)!.add(node.address);
  }
  return { folded, childrenOf };
}
