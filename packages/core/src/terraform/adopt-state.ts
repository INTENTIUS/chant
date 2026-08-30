/**
 * Adopt a Terraform-managed resource into chant source from its `.tfstate`
 * (#1009). This is the correct adoption source for carving OUT of Terraform:
 * a TF resource is created through the provider API, not CloudFormation, so it
 * is not in any CFN stack — but its resolved attributes ARE in the state file.
 *
 * The mapping itself belongs to the carve provider that owns the Terraform type
 * (`carve-provider.ts`, #2016) — aws maps snake_case provider attributes to
 * CloudFormation PascalCase props over the AWS carve-out table. This module is
 * the dispatch: it resolves the provider and hands off. A new provider adds a
 * file under `providers/`, never an edit here.
 */

import { canCarveEmit, carveEmitTypes } from "./tier-map";
import { resolveEmitProvider, type AdoptedSource, type DeferredParam } from "./carve-provider";
import type { StateResource } from "./state";

export { PARAMS_IMPORT } from "./emit-source";
export type { AdoptedSource, DeferredParam, FoldedContribution } from "./carve-provider";

/**
 * Is this Terraform type adoptable from state (a provider emits it)? The same
 * gate serves the live path, so both are the shared `canCarveEmit`.
 */
export function canAdoptFromState(tfType: string): boolean {
  return canCarveEmit(tfType);
}

/** Terraform types that can currently be adopted from state, for user-facing hints. */
export function supportedStateAdoptionTypes(): string[] {
  return carveEmitTypes();
}

/**
 * Render chant source for a state-adopted resource, through the provider that
 * owns its Terraform type. `params` carries the deferred outbound inputs the
 * boundary report found (#998) and `folded` the carve set's sub-resources read
 * from the same state file (#1637); what a provider does with them is its own
 * business, and both are reported back on the {@link AdoptedSource}.
 *
 * Null means no registered provider emits this type — the caller has already
 * refused it at the emit gate, so this is the belt-and-braces path.
 */
export function adoptFromState(
  resource: StateResource,
  params: DeferredParam[] = [],
  folded: StateResource[] = [],
): AdoptedSource | null {
  const provider = resolveEmitProvider(resource.type);
  return provider?.adopt?.(resource, params, folded) ?? null;
}
