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
 * The suffix a declarable marker's symbol description ends with.
 *
 * chant#2444 — what makes a marker mean "entity" rather than "some other kind
 * of chant value". `Symbol.for("chant.declarable")` has it; so does the
 * specification host's `Symbol.for("tsad.conformance.declarable")`.
 */
const DECLARABLE_MARKER_SUFFIX = ".declarable";

/**
 * Type guard to check if a value is a Declarable.
 *
 * chant#2444 — accepts an entity a HOST built, not only one chant built.
 *
 * `F-Host-Interface` item 1 says an entity carries a non-enumerable declarable
 * marker, and a host supplies its own: the specification's conformance host
 * marks with `Symbol.for("tsad.conformance.declarable")`. Testing identity
 * against chant's symbol alone refused those for not being chant's rather than
 * for being malformed, which is what chant#2442 hit inside composite member
 * validation and what would otherwise keep biting in the entity tallies and the
 * revival pass-through.
 *
 * ## Why NOT the reference implementation's reading
 *
 * The reference reads L6.1 as "any own symbol or non-enumerable own property",
 * which is right in its domain and **unsafe in chant's**. Two measurements say
 * so, and both were taken rather than assumed:
 *
 *   - A real chant entity's non-enumerable own NAMES are `lexicon`,
 *     `entityType`, `kind`, `props`, `attributes`, `Ref`. "Any non-enumerable
 *     own property" is therefore close to "any chant object at all".
 *   - chant has SEVEN marker symbols, not one — `chant.intrinsic`,
 *     `chant.composite`, `chant.stackOutput`, `chant.lexiconOutput`,
 *     `chant.effect-receipt`, `chant.secret-declaration`, `chant.childProject`
 *     — each a non-enumerable own symbol set to `true`. Under "any own symbol"
 *     an Intrinsic and a StackOutput both classify as Declarable, which is a
 *     worse bug than the one being fixed: they would enter the entity tallies.
 *
 * The reference can read any symbol because its domain has one. chant
 * distinguishes seven kinds BY symbol identity, so it needs the marker's name.
 * Hence the suffix: the marker must say `declarable`, whoever owns it.
 *
 * ## What the suffix cannot do
 *
 * It is a convention, not a registry. A host that marks with, say,
 * `Symbol.for("acme.entity")` carries a perfectly good non-enumerable marker
 * and is refused here, because nothing in this function knows that package is
 * one the caller named. The context that would settle it —
 * `FoldProjectOptions.lexiconPackages`, chant#2438 — lives in the fold path and
 * does not reach a type guard called from a dozen places.
 *
 * That is a deliberate trade, not an oversight: a convention that refuses an
 * unknown-but-valid marker costs a host one symbol name, while a rule loose
 * enough to accept any marker miscounts chant's own seven kinds on every build.
 * If a real host ever needs the other side of it, the fix is to thread the
 * named packages through rather than to widen the test.
 */
export function isDeclarable(value: unknown): value is Declarable {
  if (typeof value !== "object" || value === null) return false;
  // chant's own, which is every entity a chant build makes.
  if ((value as Record<symbol, unknown>)[DECLARABLE_MARKER] === true) return true;
  return carriesForeignDeclarableMarker(value);
}

/** A declarable marker some other implementation owns — see {@link isDeclarable}. */
function carriesForeignDeclarableMarker(value: object): boolean {
  for (const marker of Object.getOwnPropertySymbols(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, marker);
    // Non-enumerable and `true`, per F-Host-Interface item 1. An enumerable
    // symbol would travel through a spread and reach an artifact, which a
    // marker must not.
    if (descriptor === undefined || descriptor.enumerable || descriptor.value !== true) continue;
    if (marker.description?.endsWith(DECLARABLE_MARKER_SUFFIX) === true) return true;
  }
  return false;
}

/**
 * Type guard to check if a Declarable is a property-level type
 */
export function isPropertyDeclarable(value: Declarable): boolean {
  return value.kind === "property";
}
