/**
 * TF002: a provider a root implies has no `required_providers` entry, or an
 * incomplete one.
 *
 * A provider is implied two ways: an explicit `provider "<name>" {}` block,
 * or a resource/data type prefix (`aws_instance` implies `aws`, up to the
 * first underscore, the same heuristic tflint's `terraform_required_providers`
 * reads via `GetProviderRefs()`). The `terraform` builtin (the provider
 * behind `terraform_remote_state`) is never implied: it has no registry
 * entry to require. Every implied provider needs a `required_providers`
 * entry that is an object carrying both `source` and `version`, since the old
 * shorthand form (`aws = "~> 4.0"`, a bare string) has neither and fires the
 * same as a missing entry.
 *
 * Fires once per incomplete or missing provider, not once per resource: two
 * resources implying the same unconstrained provider produce one diagnostic.
 * Anchored on whichever entity first implied the provider, preferring an
 * explicit `provider` block over a resource/data type, so the diagnostic
 * points at the most specific place a fix belongs.
 *
 * A root with no `terraform` block at all is out of scope, same as TF001:
 * the missing block is that rule's finding, not this one's.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import {
  DATA_TYPE,
  PROVIDER_TYPE,
  RESOURCE_TYPE,
  TERRAFORM_TYPE,
  type BlockBody,
} from "../../hcl/parse";

/** The `terraform` provider backs `terraform_remote_state`; it ships with the binary, not the registry. */
const BUILTIN_PROVIDERS = new Set(["terraform"]);

function providerNameFromType(type: string): string {
  return type.split("_")[0];
}

/** One implied provider name to the entity key that first implied it in file order. */
function impliedProviders(entities: PostSynthContext["entities"], root: string): Map<string, string> {
  const implied = new Map<string, string>();
  const fromProviderBlock = new Set<string>();

  for (const [key, entity] of entities) {
    if (!isResourceDeclarable(entity)) continue;
    const props = entity.props as { root?: unknown; address?: unknown };
    if (props.root !== root) continue;
    const address = typeof props.address === "string" ? props.address : "";

    if (entity.entityType === PROVIDER_TYPE) {
      const name = address.slice("provider.".length);
      if (BUILTIN_PROVIDERS.has(name)) continue;
      implied.set(name, key);
      fromProviderBlock.add(name);
    } else if (entity.entityType === RESOURCE_TYPE) {
      const type = address.split(".")[0] ?? "";
      const name = providerNameFromType(type);
      if (BUILTIN_PROVIDERS.has(name) || fromProviderBlock.has(name)) continue;
      if (!implied.has(name)) implied.set(name, key);
    } else if (entity.entityType === DATA_TYPE) {
      const type = address.split(".")[1] ?? "";
      const name = providerNameFromType(type);
      if (BUILTIN_PROVIDERS.has(name) || fromProviderBlock.has(name)) continue;
      if (!implied.has(name)) implied.set(name, key);
    }
  }

  return implied;
}

/** `required_providers` is a nested block: hcl2json encodes it as a one-element array of `{name: entry}`. */
function requiredProvidersMap(body: BlockBody): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const blocks = body.required_providers;
  if (!Array.isArray(blocks)) return merged;
  for (const block of blocks) {
    if (typeof block === "object" && block !== null) Object.assign(merged, block);
  }
  return merged;
}

/** Why a `required_providers` entry is incomplete, or `undefined` if it's fine. */
function entryProblem(entry: unknown): string | undefined {
  if (entry === undefined) return "no `required_providers` entry";
  if (typeof entry === "string") return "the legacy shorthand form (a bare version string), which carries no `source`";
  if (typeof entry !== "object" || entry === null) return "an entry that is not a valid object";
  const obj = entry as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof obj.source !== "string" || obj.source === "") missing.push("`source`");
  if (typeof obj.version !== "string" || obj.version === "") missing.push("`version`");
  return missing.length > 0 ? `an entry missing ${missing.join(" and ")}` : undefined;
}

export const tf002: PostSynthCheck = {
  id: "TF002",
  description: "A provider the root implies has no required_providers entry, or an incomplete one",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const roots = new Set<string>();
    const requiredByRoot = new Map<string, Record<string, unknown>>();

    for (const entity of ctx.entities.values()) {
      if (entity.entityType !== TERRAFORM_TYPE || !isResourceDeclarable(entity)) continue;
      const props = entity.props as { root?: unknown; body?: unknown };
      const root = typeof props.root === "string" ? props.root : "";
      roots.add(root);
      const body = (typeof props.body === "object" && props.body !== null ? props.body : {}) as BlockBody;
      const merged = requiredByRoot.get(root) ?? {};
      Object.assign(merged, requiredProvidersMap(body));
      requiredByRoot.set(root, merged);
    }

    for (const root of [...roots].sort()) {
      const required = requiredByRoot.get(root) ?? {};
      const implied = impliedProviders(ctx.entities, root);

      for (const name of [...implied.keys()].sort()) {
        const problem = entryProblem(required[name]);
        if (!problem) continue;
        diagnostics.push({
          checkId: "TF002",
          severity: "warning",
          message:
            `Provider "${name}" is used in root module "${root}" but has ${problem} in ` +
            "`required_providers`. Add `source` and `version` for it in the terraform block's " +
            "`required_providers`, so a future provider release can't silently change behavior.",
          entity: implied.get(name),
          lexicon: "terraform",
        });
      }
    }

    return diagnostics;
  },
};
