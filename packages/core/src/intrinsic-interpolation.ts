/**
 * Tagged template interpolation helper.
 *
 * Implements the lockstep walk over tagged template literal parts/values,
 * dispatching on AttrRef / Intrinsic / Declarable / primitive.
 * Each lexicon provides format-specific serialization strings.
 */

import { AttrRef } from "./attrref";
import { INTRINSIC_MARKER } from "./intrinsic";
import { DECLARABLE_MARKER } from "./declarable";
import { isAttrRefLike } from "./utils";

export type InterpolationValueSerializer = (value: unknown) => string;

/**
 * Default serialization dispatch for interpolated values.
 *
 * Handles: AttrRef → Intrinsic (with Ref special case) → Declarable (throws) → primitive.
 * Lexicons can wrap/extend this for format-specific behavior.
 *
 * @param serializeAttrRef - Format an AttrRef: (logicalName, attribute) → string
 * @param serializeRef - Format a Ref intrinsic: (refName) → string
 */
export function defaultInterpolationSerializer(
  serializeAttrRef: (logicalName: string, attribute: string) => string,
  serializeRef: (refName: string) => string,
): InterpolationValueSerializer {
  return (value: unknown): string => {
    // Handle AttrRef. Duck-type, not `instanceof` (chant #1137): a lexicon
    // built against a separate copy of `@intentius/chant` produces AttrRefs
    // that fail `instanceof AttrRef` here but carry the same shape — and
    // since AttrRef also implements Intrinsic, missing this branch does not
    // fail loud. The value instead falls into the generic Intrinsic branch
    // below, which calls `toJSON()` (returning the `{__attrRef}` wire
    // envelope, not a `Ref`) and silently stringifies it to `[object
    // Object]` in the interpolated output.
    if (isAttrRefLike(value)) {
      const logicalName = value.getLogicalName();
      if (!logicalName) {
        throw new Error(
          `Cannot serialize AttrRef for attribute "${value.attribute}": logical name not set`,
        );
      }
      return serializeAttrRef(logicalName, value.attribute);
    }

    // Handle Intrinsics with toJSON
    if (
      typeof value === "object" &&
      value !== null &&
      INTRINSIC_MARKER in value &&
      "toJSON" in value &&
      typeof value.toJSON === "function"
    ) {
      const result = value.toJSON();
      // If it's a Ref, use the ref serializer
      if (typeof result === "object" && result !== null && "Ref" in result) {
        return serializeRef((result as { Ref: string }).Ref);
      }
      return String(value);
    }

    // Handle Declarables — error
    if (
      typeof value === "object" &&
      value !== null &&
      DECLARABLE_MARKER in value
    ) {
      throw new Error(
        "Cannot embed Declarable directly in Sub template. Use AttrRef instead.",
      );
    }

    // Primitive
    return String(value);
  };
}

/**
 * Walk tagged template literal parts/values in lockstep,
 * serializing each value via the provided serializer.
 */
export function buildInterpolatedString(
  templateParts: readonly string[],
  values: readonly unknown[],
  serializeValue: InterpolationValueSerializer,
): string {
  let result = "";
  for (let i = 0; i < templateParts.length; i++) {
    result += templateParts[i];
    if (i < values.length) {
      result += serializeValue(values[i]);
    }
  }
  return result;
}
