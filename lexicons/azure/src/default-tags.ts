/**
 * Default Tags — declares project-wide tags for all taggable Azure resources.
 *
 * When a project exports a `defaultTags(...)` declaration, the serializer
 * automatically injects those tags into every taggable resource at synthesis
 * time. Explicit tags on individual resources take precedence.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

/**
 * Marker symbol for default tags identification.
 */
export const DEFAULT_TAGS_MARKER = Symbol.for("chant.azure.defaultTags");

/**
 * A single tag entry — key is always a string, value supports strings,
 * intrinsics, or any value the serializer can resolve.
 */
export interface TagEntry {
  readonly key: string;
  readonly value: unknown;
}

/**
 * A default tags declaration — wraps a tag record into a Declarable
 * that the serializer uses to inject tags into all taggable resources.
 */
export interface DefaultTags extends Declarable {
  readonly [DEFAULT_TAGS_MARKER]: true;
  readonly [DECLARABLE_MARKER]: true;
  readonly lexicon: "azure";
  readonly entityType: "chant:azure:defaultTags";
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
 * Declare project-wide default tags for all taggable Azure resources.
 *
 * Tags are injected at synthesis time into every resource that supports
 * tagging. If a resource has an explicit tag with the same key, the
 * explicit value wins.
 *
 * @param tags - Array of { key, value } tag entries
 * @returns A DefaultTags Declarable
 *
 * @example
 * ```ts
 * import { defaultTags, Azure } from "@intentius/chant-lexicon-azure";
 *
 * export const tags = defaultTags([
 *   { key: "Project", value: "my-app" },
 *   { key: "Environment", value: "production" },
 * ]);
 * ```
 */
export function defaultTags(tags: TagEntry[]): DefaultTags {
  return {
    [DEFAULT_TAGS_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "azure",
    entityType: "chant:azure:defaultTags",
    tags,
  };
}
