/**
 * Runtime factory constructors for generated resource and property classes.
 *
 * Creates classes that implement the Declarable interface with DECLARABLE_MARKER,
 * lexicon, entityType, kind, and attribute references.
 */

import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { AttrRef } from "./attrref";

/**
 * Create a resource class for a given type.
 * The returned constructor creates Declarable objects with:
 * - DECLARABLE_MARKER for type identification
 * - lexicon identifier
 * - entityType set to the resource type
 * - kind "resource"
 * - props stored from constructor argument
 * - AttrRef instances for each attribute
 */
export function createResource(
  type: string,
  lexicon: string,
  attrMap: Record<string, string>,
): new (props: Record<string, unknown>, attributes?: Record<string, unknown>) => Declarable & Record<string, string> {
  const ResourceClass = function (this: Record<string, unknown>, props: Record<string, unknown>, attributes?: Record<string, unknown>) {
    Object.defineProperty(this, DECLARABLE_MARKER, { value: true, enumerable: false });
    Object.defineProperty(this, "lexicon", { value: lexicon, enumerable: false });
    Object.defineProperty(this, "entityType", { value: type, enumerable: false });
    Object.defineProperty(this, "kind", { value: "resource", enumerable: false });
    Object.defineProperty(this, "props", { value: props ?? {}, enumerable: false, configurable: true });
    Object.defineProperty(this, "attributes", { value: attributes ?? {}, enumerable: false, configurable: true });

    // Ref returns the resource instance itself — the serializer walker
    // detects Declarable objects and emits { Ref: logicalName }
    Object.defineProperty(this, "Ref", { value: this, enumerable: false });

    // Create AttrRef instances for each attribute
    // Must be enumerable so getAttributes() can discover them for resolveAttrRefs()
    for (const [camelName, attrName] of Object.entries(attrMap)) {
      Object.defineProperty(this, camelName, {
        value: new AttrRef(this, attrName),
        enumerable: true,
        writable: false,
      });
    }
  } as unknown as new (props: Record<string, unknown>, attributes?: Record<string, unknown>) => Declarable & Record<string, string>;

  // Set the constructor name for debugging
  Object.defineProperty(ResourceClass, "name", { value: type.split("::").pop() ?? type });

  return ResourceClass;
}

/**
 * Create a property-kind class for a given property type.
 *
 * Instances carry DECLARABLE_MARKER/lexicon/entityType/kind at runtime (set
 * via defineProperty below), so they already satisfy `Declarable` — the
 * return type just needs to say so. Before this, the signature was
 * `Record<string, unknown>` with no `Declarable`, so any composite that
 * returned a property-kind instance as a top-level member only type-checked
 * by accident: either the caller went through an untyped `require()` (losing
 * the type entirely) or never assigned the instance where its `Declarable`-ness
 * was checked statically. See chant #1068.
 */
export function createProperty(
  type: string,
  lexicon: string,
): new (props: Record<string, unknown>) => Declarable & Record<string, unknown> {
  const PropertyClass = function (this: Record<string, unknown>, props: Record<string, unknown>) {
    Object.defineProperty(this, DECLARABLE_MARKER, { value: true, enumerable: false });
    Object.defineProperty(this, "lexicon", { value: lexicon, enumerable: false });
    Object.defineProperty(this, "entityType", { value: type, enumerable: false });
    Object.defineProperty(this, "kind", { value: "property", enumerable: false });
    Object.defineProperty(this, "props", { value: props ?? {}, enumerable: false, configurable: true });
  } as unknown as new (props: Record<string, unknown>) => Declarable & Record<string, unknown>;

  Object.defineProperty(PropertyClass, "name", { value: type.split(".").pop() ?? type });

  return PropertyClass;
}
