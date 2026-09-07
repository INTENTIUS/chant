/**
 * TF028: a live root is watched by a `TerraformWatchOp` built in stock mode.
 *
 * `TerraformWatchOp`'s `live` flag is declared, not detected: a composite is
 * built by `chant build` without reading a root module's `.tf` files, so the
 * Op author says which shape the Plan phase takes and, until #2216, nothing
 * checked the answer against the root. Leaving it off a live root is silent
 * and lossy. `live: true` swaps the Plan step for `choudoufuLivePlan`, whose
 * single read of the live system answers three questions (drift, how many
 * live resources sit at a declared identity carrying no marker, and how many
 * of those an exact content match makes claimable); a stock `terraformPlan`
 * step answers the first alone, so the watch reports drift and stays quiet
 * about every unowned and adoptable resource in the estate.
 *
 * The check runs over the whole built graph because that is where both halves
 * of the question are: the root's mode is stamped on every parsed entity by
 * the build (`props.mode`, #2103), and the Op is a `Chant::Op` entity carrying
 * the composite's own labels. `TerraformWatchOp` itself cross-checks the flag
 * where it can (`../../op/resolve-root-mode.ts`), but that read is a
 * `chant.config.json`-only one, so on a `chant.config.ts` project, which is
 * every project in this repository, this check is what actually fires.
 *
 * Read off the labels the composite stamps rather than off the emitted step,
 * since a stock `terraformPlan -out` step against a live root is correct in
 * `TerraformApplyOp`: choudoufu v0.13.0 accepts `plan -out` and re-plans
 * against the file at apply (#2157), so the apply Op builds one shape for
 * both kinds of root and the step alone says nothing about a mistake.
 *
 * One diagnostic per Op, fired from the Op's entity.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { isOpEntity } from "@intentius/chant/op/resource";

/** The labels `TerraformWatchOp` stamps on the Op it builds (`../../composites/terraform-watch-op.ts`). */
interface WatchOpLabels {
  Watch?: unknown;
  TerraformRoot?: unknown;
  TerraformMode?: unknown;
}

/** Every root name the build parsed as live: `terraform.binary: "choudoufu"` plus a declared estate. */
function liveRootsOf(ctx: PostSynthContext): Set<string> {
  const roots = new Set<string>();
  for (const entity of ctx.entities.values()) {
    if (!isResourceDeclarable(entity)) continue;
    const props = entity.props as { root?: unknown; mode?: unknown };
    if (props.mode !== "live" || typeof props.root !== "string") continue;
    roots.add(props.root);
  }
  return roots;
}

export const tf028: PostSynthCheck = {
  id: "TF028",
  description: "A live root is watched by a TerraformWatchOp built without live: true",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const liveRoots = liveRootsOf(ctx);
    if (liveRoots.size === 0) return [];

    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (!isOpEntity(entity)) continue;
      const props = (entity as { props?: Record<string, unknown> }).props;
      if (!props || typeof props.name !== "string") continue;
      const labels = (typeof props.labels === "object" && props.labels !== null
        ? props.labels
        : {}) as WatchOpLabels;
      if (labels.Watch !== "true") continue;
      if (labels.TerraformMode === "live") continue;
      const root = labels.TerraformRoot;
      if (typeof root !== "string" || !liveRoots.has(root)) continue;

      diagnostics.push({
        checkId: "TF028",
        severity: "error",
        message:
          `Op "${props.name}" watches root module "${root}" in stock mode, but that root runs choudoufu ` +
          "with a declared estate. A stock plan reports drift alone and stays quiet about every unowned " +
          `and adoptable resource in the estate. Set live: true on this TerraformWatchOp, or drop the ` +
          "root's estate if it is not a live root.",
        entity: name,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
