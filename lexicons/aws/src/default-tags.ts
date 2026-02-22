/**
 * Default Tags — declares project-wide tags for all taggable resources.
 *
 * When a project exports a `defaultTags(...)` declaration, the serializer
 * automatically injects those tags into every taggable resource at synthesis
 * time. Explicit tags on individual resources take precedence.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

/**
 * Marker symbol for default tags identification.
 */
export const DEFAULT_TAGS_MARKER = Symbol.for("chant.aws.defaultTags");

/**
 * A single tag entry — Key is always a string, Value supports strings,
 * Parameters, intrinsics, or any value the serializer can resolve.
 */
export interface TagEntry {
  readonly Key: string;
  readonly Value: unknown;
}

/**
 * A default tags declaration — wraps a tag array into a Declarable
 * that the serializer uses to inject tags into all taggable resources.
 */
export interface DefaultTags extends Declarable {
  readonly [DEFAULT_TAGS_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: "aws";
  readonly entityType: "chant:aws:defaultTags";
  readonly tags: readonly TagEntry[];
}

/**
 * Type guard for DefaultTags.
 */
export function isDefaultTags(value: unknown): value is DefaultTags {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFAULT_TAGS_MARKER in value &&
    (value as Record<symbol, unknown>)[DEFAULT_TAGS_MARKER] === true
  );
}

/**
 * Declare project-wide default tags for all taggable resources.
 *
 * Tags are injected at synthesis time into every resource that supports
 * tagging (per the CloudFormation Registry metadata). If a resource has
 * an explicit Tag with the same Key, the explicit value wins.
 *
 * @param tags - Array of { Key, Value } tag entries
 * @returns A DefaultTags Declarable
 *
 * @example
 * ```ts
 * import { defaultTags, Sub, AWS } from "@intentius/chant-lexicon-aws";
 *
 * export const tags = defaultTags([
 *   { Key: "Project", Value: "my-app" },
 *   { Key: "Environment", Value: Sub`${AWS.StackName}` },
 * ]);
 * ```
 */
export function defaultTags(tags: TagEntry[]): DefaultTags {
  return {
    [DEFAULT_TAGS_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "aws",
    entityType: "chant:aws:defaultTags",
    tags,
  };
}
