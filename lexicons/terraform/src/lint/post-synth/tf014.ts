/**
 * TF014: a `provider` block inside a child module that configures anything.
 *
 * Scope: child modules only. A `provider` block in the ROOT module is where
 * providers are supposed to be configured, and TF008 is what checks its
 * contents.
 *
 * A child module that configures its own provider takes the decision away
 * from its caller: the caller can no longer point the module at a different
 * region, account or endpoint, and two calls of the module in one root cannot
 * differ. Worse, Terraform cannot remove a module whose provider is declared
 * inside it, because destroying the resources needs a provider configuration
 * that the removal itself deletes. That is the "Provider configuration not
 * present" failure that leaves a root unable to plan.
 *
 * The one legal form is a provider block that declares only `alias`, which
 * names a slot the caller fills through `providers = { aws.replica =
 * aws.west }`. That is a declaration, not a configuration, so a block whose
 * body has nothing but `alias` is not reported. Everything else is: a
 * `region`, a `profile`, an `assume_role` block, and `version` too, which has
 * been deprecated in favour of `required_providers` since Terraform 0.13.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { PROVIDER_TYPE, type BlockBody, type TerraformEntity } from "../../hcl/parse";
import { isChildScoped } from "./scope";

/** Everything in a provider body that is not the `alias` slot declaration. */
function configuredKeys(body: BlockBody): string[] {
  return Object.keys(body).filter((key) => key !== "alias");
}

export const tf014: PostSynthCheck = {
  id: "TF014",
  description: "Child module configures a provider block",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [key, entity] of ctx.entities) {
      if (entity.entityType !== PROVIDER_TYPE || !isResourceDeclarable(entity)) continue;
      if (!isChildScoped(entity)) continue;

      const props = (entity as TerraformEntity).props as Partial<TerraformEntity["props"]>;
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const configured = configuredKeys(body);
      if (configured.length === 0) continue;

      const address = typeof props.address === "string" ? props.address : key;
      diagnostics.push({
        checkId: "TF014",
        severity: "warning",
        message:
          `Child module block "${address}" configures a provider (${configured.sort().join(", ")}). ` +
          "A module that configures its own provider cannot be pointed at another region or account by " +
          "its caller, cannot be called twice with different settings, and cannot be removed, since " +
          "destroying its resources needs the provider configuration the removal deletes. Configure the " +
          "provider in the root module and pass it in with `providers = { ... }`, leaving at most an " +
          "`alias`-only block here.",
        entity: key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
