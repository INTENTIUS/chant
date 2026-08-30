/**
 * The CDK half of `chant carve advise` (#1056): read a cloud assembly, rank its
 * constructs with the same model the Terraform advisor uses.
 *
 * Read-only, like the Terraform path — it emits nothing, patches nothing, and
 * touches no live resource. `carve emit`, `carve bridge` and `carve apply` are
 * deliberately Terraform-only: bridging a CDK carve means rewriting the
 * surviving app's source, which does not generalize across jsii languages.
 */

import { readCloudAssembly } from "./assembly";
import { buildCdkGraph } from "./graph";
import { resolveCfnTier } from "./tier-map";
import type { CarveDialect } from "../terraform/carve";
import type { Peelability, ScoreOptions } from "../terraform/score";
import { scoreEstate } from "../terraform/score";
import type { TfGraph } from "../terraform/types";

export interface CdkAdvice {
  graph: TfGraph;
  results: Peelability[];
  /** The hooks that produced `results`, so the boundary pass agrees with it. */
  scoreOptions: ScoreOptions;
  diagnostics: string[];
}

/** The bridge vocabulary a CDK report's boundary edges are named in. */
export const CDK_DIALECT: CarveDialect = "cdk";

/**
 * Rank a cloud assembly. The scoring model, the bands and the report shape are
 * the Terraform path's, verbatim; what changes is the tier lookup (already in
 * CloudFormation type space, so no translation) and the signals only a CDK
 * reader can see — assets, nested stacks, L3 subtrees, a dummy-value assembly.
 */
export function adviseCloudAssembly(dir: string): CdkAdvice {
  const assembly = readCloudAssembly(dir);
  const { graph, signals, diagnostics } = buildCdkGraph(assembly);
  const scoreOptions: ScoreOptions = {
    tierOf: resolveCfnTier,
    signalsFor: (node) => signals.get(node.address) ?? {},
  };
  return { graph, results: scoreEstate(graph, scoreOptions), scoreOptions, diagnostics };
}
