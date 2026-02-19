/**
 * Marker symbol for Intrinsic type identification
 */
export const INTRINSIC_MARKER = Symbol.for("chant.intrinsic");

/**
 * Base interface for lexicon-provided intrinsic functions
 */
export interface Intrinsic {
  readonly [INTRINSIC_MARKER]: true;
  toJSON(): unknown;
}

/**
 * Type guard to check if a value is an Intrinsic
 */
export function isIntrinsic(value: unknown): value is Intrinsic {
  return (
    typeof value === "object" &&
    value !== null &&
    INTRINSIC_MARKER in value &&
    (value as Record<symbol, unknown>)[INTRINSIC_MARKER] === true
  );
}

/**
 * Recursively unwrap intrinsic values by calling `toJSON()`.
 *
 * - If the value has the INTRINSIC_MARKER and a `toJSON` method, calls it.
 * - If the value is an array, recurses into each element.
 * - Otherwise returns the value as-is.
 */
export function resolveIntrinsicValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && INTRINSIC_MARKER in value) {
    if ("toJSON" in value && typeof value.toJSON === "function") {
      return value.toJSON();
    }
  }
  if (Array.isArray(value)) {
    return value.map(resolveIntrinsicValue);
  }
  return value;
}
