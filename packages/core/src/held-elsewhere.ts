/**
 * `heldElsewhere` — a typed, per-property declaration that a field belongs to
 * something else once the first apply happens (chant #2162).
 *
 * An autoscaler owns a Deployment's `replicas` after the first apply. A
 * controller writes an annotation on every sync. An operator was granted one
 * knob deliberately. None of these are drift, and reconciling them back to
 * whatever chant last declared would fight the thing that is actually
 * supposed to own the field.
 *
 * Terraform's answer is `lifecycle { ignore_changes = [...] }`: a list of
 * strings, carrying no reason, invisible once written. This is the typed
 * alternative — a marker written where the property's value would go, so a
 * lexicon's generated types check it the same way they check any other value,
 * and it cannot be attached to a property that does not exist.
 *
 * This is not a suppression comment. `chant-ignore` (#2111) hides a *lint*
 * finding about source; a `heldElsewhere` marker is a fact about who operates
 * a field at *runtime*, so it lives in the typed declaration, where
 * `chant lifecycle plan` and `chant lifecycle diff --live` can render it,
 * rather than in a comment only a linter reads.
 */

/**
 * Runtime-only marker, symbol-keyed so it never collides with a real
 * property actually named `by` or `reason` and never serializes by accident
 * through `JSON.stringify` or `Object.entries` (which do not visit symbol
 * keys) — the two places a stray plain-object marker would otherwise leak
 * into a snapshot or a wire payload unnoticed.
 */
export const HELD_ELSEWHERE_MARKER = Symbol.for("chant.heldElsewhere");

export interface HeldElsewhereOptions {
  /** Who holds the field at runtime — the autoscaler, the controller, the operator. Free text: whatever names the holder on this substrate ("hpa", "cluster-autoscaler", "the on-call operator who set this by hand"). */
  by: string;
  /** Why chant does not reconcile this field after the first apply. */
  reason: string;
}

/** The runtime shape a `heldElsewhere()` call actually produces. */
export interface HeldElsewhereMarker extends HeldElsewhereOptions {
  readonly [HELD_ELSEWHERE_MARKER]: true;
}

/**
 * Declare a property held by something else after the first apply.
 *
 * Typed `T` — the property's own declared type — rather than
 * `HeldElsewhereMarker`, so it type-checks in exactly the position the
 * property's real value would go: `replicas: heldElsewhere({ by: "hpa",
 * reason: "the autoscaler owns replicas after the first apply" })` against a
 * generated `replicas?: number` typechecks the same way `replicas: 3` does,
 * and writing it against a property that does not exist on the resource's
 * props is an excess-property error like any other.
 *
 * The runtime value is the marker object, not a `T` — this function tells
 * TypeScript otherwise on purpose. Every consumer that must tell the two
 * apart checks {@link isHeldElsewhere} before trusting a declared value's
 * real shape: the synth-time serializer (`serializer-walker.ts`, which omits
 * the field from the applied payload so the property is never sent — the
 * provider defaults it once at creation, and the holder owns it from there)
 * and the deep-diff declared side (`deep-observation.ts`/`deep-diff.ts`,
 * which reports a live difference as held rather than as drift).
 */
export function heldElsewhere<T>(opts: HeldElsewhereOptions): T {
  const marker: HeldElsewhereMarker = {
    [HELD_ELSEWHERE_MARKER]: true,
    by: opts.by,
    reason: opts.reason,
  };
  return marker as unknown as T;
}

/**
 * True when `value` is a {@link HeldElsewhereMarker} — the runtime shape a
 * `heldElsewhere()` call produces, wherever it ends up (a resource's own
 * prop, nested inside a property-kind Declarable's props).
 */
export function isHeldElsewhere(value: unknown): value is HeldElsewhereMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[HELD_ELSEWHERE_MARKER] === true
  );
}

/**
 * JSON-safe tag a held marker normalizes to (see `deep-observation.ts`) so
 * its identity survives normalization, `flattenDeepProperties`, and a
 * `--json` round-trip. The symbol marker above does not serialize and
 * `Object.entries` does not enumerate it, so without a JSON-safe stand-in the
 * normalization pass would flatten `{ by, reason }` into two ordinary leaf
 * paths instead of keeping the marker recognizable as one value.
 */
export const HELD_ELSEWHERE_TAG = "chant:heldElsewhere" as const;

/** The normalized, JSON-safe form of a {@link HeldElsewhereMarker}. */
export interface NormalizedHeldElsewhere extends HeldElsewhereOptions {
  readonly heldElsewhere: typeof HELD_ELSEWHERE_TAG;
}

/** Normalize a runtime marker to its JSON-safe tagged form. */
export function normalizeHeldElsewhere(marker: HeldElsewhereMarker): NormalizedHeldElsewhere {
  return { heldElsewhere: HELD_ELSEWHERE_TAG, by: marker.by, reason: marker.reason };
}

/** True when `value` is the normalized, JSON-safe tagged form of a held marker. */
export function isNormalizedHeldElsewhere(value: unknown): value is NormalizedHeldElsewhere {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { heldElsewhere?: unknown }).heldElsewhere === HELD_ELSEWHERE_TAG
  );
}
