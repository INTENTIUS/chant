/**
 * Stamps non-enumerable Declarable properties onto plain ARM resource objects
 * so that collectEntities() / isDeclarable() recognizes them.
 *
 * All original enumerable properties stay intact — existing tests that
 * access `.type`, `.properties`, `.tags`, etc. are unaffected.
 */

import { DECLARABLE_MARKER } from "@intentius/chant/declarable";

/** ARM meta-fields that are NOT part of the flattened props. */
const ARM_META_FIELDS = new Set(["type", "apiVersion", "dependsOn"]);

/**
 * Mark a plain ARM resource object as Declarable so the build pipeline
 * discovers and serializes it.
 *
 * Adds non-enumerable: DECLARABLE_MARKER, entityType, lexicon, props, attributes.
 * The `props` object is a flattened merge of top-level fields + `properties.*`.
 */
export function markAsAzureResource(obj: Record<string, unknown>): Record<string, unknown> {
  const type = obj.type as string;
  const dependsOn = obj.dependsOn as string[] | undefined;

  // Flatten: top-level non-meta fields + properties.*
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (ARM_META_FIELDS.has(key) || key === "properties") continue;
    props[key] = value;
  }
  if (typeof obj.properties === "object" && obj.properties !== null) {
    for (const [key, value] of Object.entries(obj.properties as Record<string, unknown>)) {
      props[key] = value;
    }
  }

  const apiVersion = obj.apiVersion as string | undefined;

  const attributes: Record<string, unknown> = {};
  if (dependsOn) {
    attributes.DependsOn = dependsOn;
  }
  if (apiVersion) {
    attributes.apiVersion = apiVersion;
  }

  Object.defineProperty(obj, DECLARABLE_MARKER, { value: true, enumerable: false });
  Object.defineProperty(obj, "entityType", { value: type, enumerable: false });
  Object.defineProperty(obj, "lexicon", { value: "azure", enumerable: false });
  Object.defineProperty(obj, "props", { value: props, enumerable: false, configurable: true });
  Object.defineProperty(obj, "attributes", { value: attributes, enumerable: false, configurable: true });

  return obj;
}
