/**
 * Marker symbol for Declarable type identification
 */
export const DECLARABLE_MARKER = Symbol.for("chant.declarable");

/**
 * Base interface for all declarable entities
 */
export interface Declarable {
  readonly lexicon: string;
  readonly entityType: string;
  readonly kind?: "resource" | "property";
  readonly [DECLARABLE_MARKER]: true;
}

/**
 * Core parameter type for lexicon-agnostic parameters
 */
export interface CoreParameter extends Declarable {
  readonly parameterType: string;
}

/**
 * Core output type for lexicon-agnostic outputs
 */
export interface CoreOutput extends Declarable {
  readonly value: unknown;
}

/**
 * Type guard to check if a value is a Declarable
 */
export function isDeclarable(value: unknown): value is Declarable {
  return (
    typeof value === "object" &&
    value !== null &&
    DECLARABLE_MARKER in value &&
    (value as Record<symbol, unknown>)[DECLARABLE_MARKER] === true
  );
}

/**
 * Type guard to check if a Declarable is a property-level type
 */
export function isPropertyDeclarable(value: Declarable): boolean {
  return value.kind === "property";
}
