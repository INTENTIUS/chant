/**
 * The claimed-field set (#2160) — which properties this declaration ever set.
 *
 * chant's ownership question has always been answered per resource, from a
 * marker: is this thing mine. The finer question was never asked. A live
 * property tree carries fields nobody declared — an autoscaler's replica count,
 * a controller's annotation, a value a person typed into a console — and the
 * deep diff (./lifecycle/deep-diff.ts) reported every one of them as a
 * difference, because a difference is all a two-way comparison can produce.
 *
 * Every lexicon has been paying for that in hand-written knowledge.
 * `DeepNormalizationHooks.prune` is where the noise goes, and three of the four
 * hooks exist because the live tree holds fields the declaration never
 * mentions. Kubernetes is the one substrate that escapes it: the API server
 * records a field manager per field (`metadata.managedFields`), so a foreign
 * write is a fact about the object rather than a rule somebody maintains.
 * `lexicons/gcp/src/deep-observe.ts` says why nobody else can do that — "a REST
 * payload carries no field ownership" — and answers with a static per-kind
 * table instead.
 *
 * The declaration is the table they are missing. A `ResourceDeclarable`'s
 * `props` are exactly the fields chant set, they are available on every
 * substrate, and they come from the same build that produced the entity.
 * Nothing has to come back from the provider.
 *
 * ## The grammar is the diff's grammar
 *
 * A claim is a set of property paths in the form `flattenDeepProperties`
 * produces: `spec.replicas`, `Tags[#env].Value`, `ingress[0].fromPort`. Same
 * hooks, same normalization, same flattening — so a path in the claim and a
 * path in the diff are the same string or they are different fields. Deriving
 * the claim any other way (walking raw props, say) would give a set that agrees
 * with the diff for most trees and disagrees for exactly the ones the hooks
 * were written for.
 *
 * ## Membership is exact, deliberately
 *
 * A claimed path is matched exactly, never by its index-erased pattern
 * (`Tags[].Value`). The pattern is the right test for
 * {@link import("./deep-observation").DeepNode.counterpart}, which asks a
 * shape question ("did source declare tag values at all") before array order is
 * canonical. Classification asks a value question, and it pairs a declared
 * value with a live one at the same path. A pattern match would answer
 * "declared" for a path that has no declared value to compare against, which is
 * neither of the two declared classifications and would quietly become a third
 * meaning of "drift".
 *
 * ## What the claim does not decide
 *
 * It does not prune. A field chant never declared still reaches the diff, still
 * appears in the report, and still carries its live value — it is reported as
 * unclaimed rather than dropped, because chant #1191 already lost a
 * console-added label by pruning what it could not attribute. What the claim
 * changes is the verdict: unclaimed is not drift, and drift is the only thing
 * that may become an update.
 */

import {
  deepValueEqual,
  flattenDeepProperties,
  normalizeDeepProperties,
  type DeepNormalizationHooks,
} from "./deep-observation";

/**
 * The set of property paths one declaration claims — every path its `props`
 * flatten to, in the diff's own grammar.
 *
 * Opaque on purpose: {@link isClaimed} is the only membership test, so a
 * consumer cannot accidentally invent a looser one (see the module doc on
 * pattern matching).
 */
export interface ClaimedFieldSet {
  /** Flattened property paths, exactly as the diff addresses them. */
  readonly paths: ReadonlySet<string>;
}

/**
 * How one LIVE value relates to the claim. Three answers where a two-way diff
 * had two:
 *
 * - `declared-equal` — chant set this field and the cloud agrees. Nothing to say.
 * - `declared-changed` — chant set this field and the cloud holds something
 *   else. This is drift, and it is the only classification that may become an
 *   update.
 * - `undeclared` — the field has a value and chant never set it. Somebody else
 *   holds it. Reported, never proposed, never counted as drift.
 *
 * A declared path with no live value at all is not in this enumeration: there
 * is no live value to classify. The diff keeps reporting that case as `absent`.
 */
export type FieldClaim = "declared-equal" | "declared-changed" | "undeclared";

/** Which source answered "who holds this field". */
export type FieldClaimSource =
  /**
   * The substrate named the manager. Kubernetes' `metadata.managedFields`, and
   * nowhere else today — strictly better than the claim, because it says who.
   */
  | "field-manager"
  /**
   * The declaration answered: the path is not in the claimed-field set, so
   * chant never set it. Says that it is somebody else's without saying whose,
   * which is the best any substrate without ownership metadata can do.
   */
  | "claimed-fields";

/** An empty claim — a declaration with no props, and the safe default. */
export const NO_CLAIMED_FIELDS: ClaimedFieldSet = { paths: new Set<string>() };

/**
 * Build a claim from an already-normalized declared property tree.
 *
 * `options` must be the same {@link FlattenDeepOptions} the diff flattens the
 * declared side with, or the two disagree about keyed list segments.
 */
export function claimedFieldsOfTree(
  declared: Record<string, unknown>,
  options: { entityType: string; hooks?: DeepNormalizationHooks },
): ClaimedFieldSet {
  const flat = flattenDeepProperties(declared, {
    entityType: options.entityType,
    side: "declared",
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  return { paths: new Set(flat.keys()) };
}

/**
 * Build a claim straight from a declaration's raw `props` — the entry point for
 * a consumer that has an entity and no diff.
 *
 * Normalizes with the lexicon's own hooks first, exactly as the diff does, so
 * pruned and masked paths land the same way on both routes. `livePaths` is the
 * counterpart set (`deepPathSet` over the live tree) where the caller has one:
 * without it the pass runs one-sided and any hook gated on
 * {@link import("./deep-observation").DeepNode.counterpart} sees `"unknown"`,
 * which is the honest answer and prunes nothing default-related.
 */
export function claimedFieldsOfProps(
  props: Record<string, unknown>,
  options: {
    entityType: string;
    hooks?: DeepNormalizationHooks;
    livePaths?: ReadonlySet<string>;
  },
): ClaimedFieldSet {
  const normalized = normalizeDeepProperties(props, {
    entityType: options.entityType,
    side: "declared",
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.livePaths ? { counterpartPaths: options.livePaths } : {}),
  });
  return claimedFieldsOfTree(normalized, options);
}

/** True when this declaration set the property at `path`. */
export function isClaimed(claimed: ClaimedFieldSet | undefined, path: string): boolean {
  return claimed !== undefined && claimed.paths.has(path);
}

/**
 * The claim as a sorted array — the wire form, for
 * {@link import("./deep-observation").DeepResourceObservation.claimedFields}
 * and for anything serializing a result to JSON.
 */
export function claimedFieldPaths(claimed: ClaimedFieldSet): string[] {
  return [...claimed.paths].sort();
}

/** Rebuild a claim from its wire form. */
export function claimedFieldsFromPaths(paths: Iterable<string>): ClaimedFieldSet {
  return { paths: new Set(paths) };
}

/**
 * Classify one live value against the claim.
 *
 * `declaredValue` is only read when the path is claimed; pass whatever the
 * declared tree holds there (including `undefined`, which is a legal declared
 * value on a claimed path only in the sense that the flattener never emits it).
 */
export function classifyLiveField(input: {
  claimed: ClaimedFieldSet | undefined;
  path: string;
  declaredValue: unknown;
  liveValue: unknown;
}): FieldClaim {
  if (!isClaimed(input.claimed, input.path)) return "undeclared";
  return deepValueEqual(input.declaredValue, input.liveValue) ? "declared-equal" : "declared-changed";
}

/**
 * Who holds an undeclared live field, and which source said so.
 *
 * The manager wins where the substrate records one: "owned by `hpa-controller`"
 * and "chant never set it" are the same verdict with very different amounts of
 * information in them, and an operator can act on the first. The claim is the
 * fallback, and it answers on every substrate.
 */
export function heldBy(fieldOwners: Record<string, string> | undefined, path: string): {
  holder?: string;
  source: FieldClaimSource;
} {
  const manager = fieldOwners?.[path];
  if (manager) return { holder: manager, source: "field-manager" };
  return { source: "claimed-fields" };
}
