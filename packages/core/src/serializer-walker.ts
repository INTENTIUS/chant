/**
 * Generic recursive value walker for lexicon serializers.
 *
 * Implements the dispatch chain: null → AttrRef → Intrinsic → Declarable → Array → Object,
 * delegating format-specific behavior to a SerializerVisitor.
 */

import type { Declarable } from "./declarable";
import { isPropertyDeclarable } from "./declarable";
import { INTRINSIC_MARKER } from "./intrinsic";
import { AttrRef } from "./attrref";
import { isAttrRefLike } from "./utils";

export interface SerializerVisitor {
  /** Format an attribute reference (e.g. CFN Fn::GetAttr). */
  attrRef(logicalName: string, attribute: string): unknown;
  /** Format a resource-level Declarable reference (e.g. CFN Ref). */
  resourceRef(logicalName: string): unknown;
  /** Format a property-level Declarable by walking its props. */
  propertyDeclarable(entity: Declarable, walk: (v: unknown) => unknown): unknown;
}

/**
 * Recursively walk a value, converting AttrRefs, Intrinsics, Declarables,
 * arrays, and objects using the provided visitor.
 */
export function walkValue(
  value: unknown,
  entityNames: Map<Declarable, string>,
  visitor: SerializerVisitor,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle AttrRef
  if (isAttrRefLike(value)) {
    const name = value.getLogicalName();
    if (!name) {
      throw new Error(
        `Cannot serialize AttrRef for attribute "${value.attribute}": logical name not set`
      );
    }
    return visitor.attrRef(name, value.attribute);
  }

  // Handle Intrinsics — walk the toJSON() result to resolve any embedded AttrRef markers
  if (typeof value === "object" && value !== null && INTRINSIC_MARKER in value) {
    if ("toJSON" in value && typeof value.toJSON === "function") {
      return walkValue(value.toJSON(), entityNames, visitor);
    }
  }

  // Handle Declarable references
  if (typeof value === "object" && value !== null && "entityType" in value) {
    const decl = value as Declarable;
    if (isPropertyDeclarable(decl)) {
      return visitor.propertyDeclarable(decl, (v) => walkValue(v, entityNames, visitor));
    }
    const name = entityNames.get(decl);
    if (name) {
      return visitor.resourceRef(name);
    }
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item) => walkValue(item, entityNames, visitor));
  }

  // Handle serialized AttrRef envelopes (produced by AttrRef.toJSON() inside intrinsics)
  if (typeof value === "object" && "__attrRef" in value) {
    const ref = (value as { __attrRef: { entity: string; attribute: string } }).__attrRef;
    return visitor.attrRef(ref.entity, ref.attribute);
  }

  // Handle objects
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const outKey = key;
      result[outKey] = walkValue(val, entityNames, visitor);
    }
    return result;
  }

  return value;
}
