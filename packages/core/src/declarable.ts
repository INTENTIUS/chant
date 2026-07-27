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
  readonly kind?: "resource" | "property" | "output";
  readonly [DECLARABLE_MARKER]: true;
}

/**
 * A `Declarable` that carries a resource payload — the `props`/`attributes`
 * fields that most lexicon serializers read to produce output. Not every
 * `Declarable` has one (outputs and parameters genuinely don't), so this is
 * kept as a sub-interface rather than widening the base type. See chant #1049.
 */
export interface ResourceDeclarable extends Declarable {
  readonly props: unknown;
  readonly attributes?: unknown;
}

/**
 * Type guard for `ResourceDeclarable` — replaces the ad-hoc `"props" in x`
 * checks that were previously repeated (with an `as unknown as` cast) at every
 * call site that reads `props`/`attributes` off a `Declarable`.
 */
export function isResourceDeclarable(value: Declarable): value is ResourceDeclarable {
  return "props" in value;
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
