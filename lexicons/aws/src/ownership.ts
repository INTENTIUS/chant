/**
 * The aws lexicon's ownership tag convention. AWS tag keys allow `:`, so
 * chant's markers use the `chant:<name>` form (distinct from the label-based
 * convention core keeps for k8s/gcp). Core owns the generic stamp/detect logic
 * (@intentius/chant/ownership); this is the aws-specific key naming it stamps.
 */

import type { ChannelKeys } from "@intentius/chant/ownership";

/** AWS tag keys for chant's ownership markers. */
export const AWS_TAG_OWNERSHIP_KEYS: ChannelKeys = {
  managedBy: "chant:managed-by",
  stack: "chant:stack",
  env: "chant:env",
};

/**
 * Template-level `Metadata` key the serializer stamps the ownership marker
 * under (#1222). Stack-level teardown verifies ownership on the *stack's own*
 * tags, and CloudFormation stack tags are an API parameter, not a template
 * section — so the template carries the marker here and the apply paths
 * (`awsApply`, the `cfn-deploy` change set) turn it into stack tags on
 * create/update. One source: the same build that stamps resource tags decides
 * the stack tags.
 */
export const OWNERSHIP_METADATA_KEY = "chant:ownership";

/**
 * The stack tags a template body asks for: the flat tag map under
 * `Metadata["chant:ownership"]`, or nothing. Total on bad input — a body that
 * is not JSON (a YAML template, a handwritten one) or carries no marker
 * returns `{}`, and the stack simply stays untagged, which teardown reports
 * as unverified rather than deleting.
 */
export function ownershipStackTagsForBody(body: string): Record<string, string> {
  let template: unknown;
  try {
    template = JSON.parse(body);
  } catch {
    return {};
  }
  if (typeof template !== "object" || template === null) return {};
  const metadata = (template as { Metadata?: unknown }).Metadata;
  if (typeof metadata !== "object" || metadata === null) return {};
  const marker = (metadata as Record<string, unknown>)[OWNERSHIP_METADATA_KEY];
  if (typeof marker !== "object" || marker === null) return {};
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(marker as Record<string, unknown>)) {
    if (typeof value === "string") tags[key] = value;
  }
  return tags;
}
