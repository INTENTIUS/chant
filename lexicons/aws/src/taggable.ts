/**
 * Shared taggable resource lookup — loads from the generated lexicon JSON.
 *
 * Lazy-loaded and cached for the lifetime of the process.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { moduleSourceDir } from "@intentius/chant/module-source";

/** How a type's tags are written: a `[{Key, Value}]` list or a key-to-value map. */
export type TagShape = "list" | "map";

/** The property a type's tags live in, and its shape (#4350). */
export interface TagPlacement {
  property: string;
  shape: TagShape;
}

interface LexiconEntry {
  kind: string;
  resourceType: string;
  tagging?: {
    taggable: boolean;
    tagOnCreate: boolean;
    tagUpdatable: boolean;
    tagProperty?: string;
    tagShape?: TagShape;
  };
  [key: string]: unknown;
}

let _cached: Map<string, TagPlacement | null> | undefined;

/**
 * Every taggable type, mapped to where its tags go. `null` means the schema
 * puts the tags somewhere chant can't stamp (inside an array, or under a
 * wrapper object), so the type gets no stamped tags.
 */
export function loadTagPlacements(): Map<string, TagPlacement | null> {
  if (_cached) return _cached;

  const map = new Map<string, TagPlacement | null>();
  try {
    const lexiconPath = join(moduleSourceDir(import.meta.url), "generated", "lexicon-aws.json");
    const content = readFileSync(lexiconPath, "utf-8");
    const data = JSON.parse(content) as Record<string, LexiconEntry>;

    for (const [_name, entry] of Object.entries(data)) {
      if (entry.kind !== "resource" || !entry.resourceType || !entry.tagging?.taggable) continue;
      const { tagProperty, tagShape } = entry.tagging;
      map.set(entry.resourceType, tagProperty && tagShape ? { property: tagProperty, shape: tagShape } : null);
    }
  } catch {
    // Lexicon not available — skip
  }

  _cached = map;
  return map;
}

/**
 * Load taggable resource types from the lexicon JSON.
 * Result is cached after first call.
 */
export function loadTaggableResources(): Set<string> {
  return new Set(loadTagPlacements().keys());
}

/** Where `type`'s tags go, or undefined when it isn't taggable or can't be placed. */
export function tagPlacementFor(type: string): TagPlacement | undefined {
  return loadTagPlacements().get(type) ?? undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a CloudFormation intrinsic (`Ref`, `Fn::*`), which can't be merged into. */
export function isTagIntrinsic(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === "Ref" || keys[0].startsWith("Fn::"));
}

/**
 * Read a tag value of either shape into a key-to-value map: a `[{Key, Value}]`
 * list or a plain map. An intrinsic or anything else reads as `{}`.
 */
export function readTagValue(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    for (const t of value) {
      if (isPlainObject(t) && typeof t.Key === "string") out[t.Key] = t.Value;
    }
    return out;
  }
  if (isPlainObject(value) && !isTagIntrinsic(value)) return { ...value };
  return out;
}

/**
 * The tags on a resource's property tree, read through the type's own tag
 * property (`UserPoolTags` on a Cognito user pool), falling back to `Tags`
 * when the type is unknown. Either shape reads (#4350).
 */
export function readResourceTags(type: string | undefined, properties: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!properties) return {};
  const placement = type ? tagPlacementFor(type) : undefined;
  return readTagValue(properties[placement?.property ?? "Tags"]);
}
