/**
 * The observation contract (#1089) — what a lexicon's `describeResources()`
 * is allowed to mean.
 *
 * Before this module there were two ways for an observation to return nothing
 * for a declared entity and no way to tell them apart:
 *
 *   1. The provider was asked and said the resource does not exist.
 *   2. The lexicon never looked — no reader for that kind, the read errored,
 *      no credentials, no cluster/subscription binding.
 *
 * Both arrived at the change set as "absent", and absent + declared classifies
 * as `create`. So `chant lifecycle plan` proposed creating a Kubernetes CRD
 * that already existed in the cluster, with nothing in the plan to say the tool
 * had simply not looked (a warn on stderr is not a signal in a change set).
 *
 * The contract is a tri-state, per declared entity:
 *
 *   - **OBSERVED-PRESENT** — a key in `resources`. The provider returned it.
 *   - **OBSERVED-ABSENT** — in neither map. The lexicon looked and the provider
 *     reported it missing. This is the only shape that may become a `create`.
 *   - **NOT-OBSERVED** — a key in `unobserved`, carrying a total
 *     {@link UnobservedReason}. Never a `create`, never a `delete`; consumers
 *     surface it and stop.
 *
 * Compatibility: `describeResources()` may still return the bare
 * `name → ResourceMetadata` map it always did — that means "everything I was
 * asked about, I looked at" and normalizes to an empty `unobserved`. Reporting
 * NOT-OBSERVED requires the explicitly versioned {@link ObservationResult}
 * envelope, which is discriminated by its literal `observation: "v1"` field (a
 * bare map's value at any key is a `ResourceMetadata` object, never that
 * string, so the two shapes can never be confused).
 */

import type { ResourceMetadata } from "./lexicon";

/**
 * Why a declared entity was not observed. Total: a lexicon that cannot observe
 * an entity must pick one of these, and consumers may switch exhaustively.
 *
 * - `read-failed` — the provider was reached and the read errored (a non-zero
 *   CLI exit, a 5xx, an unparseable response).
 * - `no-credentials` — no usable credentials/authorization for the target.
 * - `no-binding` — the environment resolves to no concrete target (no kubectl
 *   context, no subscription, no stack, no endpoint).
 * - `unsupported-kind` — the lexicon has no reader for this entity type (the
 *   K8s CRD case, Azure's nested ARM types). The resource may well exist.
 * - `filtered` — the entity was reached but withheld by a caller-requested
 *   filter (`owned: true` against a resource carrying no chant marker). The
 *   result deliberately says nothing about it, which is still not absence: a
 *   declared resource that exists but is foreign must not classify as `create`.
 */
export type UnobservedReason =
  | "read-failed"
  | "no-credentials"
  | "no-binding"
  | "unsupported-kind"
  | "filtered";

/** Every legal {@link UnobservedReason}, for validation and conformance checks. */
export const UNOBSERVED_REASONS: readonly UnobservedReason[] = [
  "read-failed",
  "no-credentials",
  "no-binding",
  "unsupported-kind",
  "filtered",
];

/** True when `value` is a legal {@link UnobservedReason}. */
export function isUnobservedReason(value: unknown): value is UnobservedReason {
  return typeof value === "string" && (UNOBSERVED_REASONS as readonly string[]).includes(value);
}

/** One declared entity the lexicon could not observe, and why. */
export interface UnobservedEntity {
  /** Declared entity type, when the lexicon knows it (it usually does — the entity is declared). */
  type?: string;
  /** Total verdict. */
  reason: UnobservedReason;
  /** Human-readable detail: the command that failed, the missing binding key, the unsupported kind. */
  detail?: string;
}

/**
 * The observation envelope — a `describeResources()` return value that can say
 * "I did not look at this one". Explicitly versioned: `observation: "v1"`.
 */
export interface ObservationResult {
  /** Discriminant + wire version. Distinguishes the envelope from the bare `name → ResourceMetadata` map. */
  readonly observation: "v1";
  /** OBSERVED-PRESENT, keyed by chant entity name. */
  resources: Record<string, ResourceMetadata>;
  /** NOT-OBSERVED, keyed by chant entity name. Omit or leave empty when everything asked about was looked at. */
  unobserved?: Record<string, UnobservedEntity>;
}

/**
 * What `describeResources()` may return: the bare map (pre-#1089, still valid —
 * "I looked at everything") or the {@link ObservationResult} envelope.
 */
export type DescribeResourcesResult = Record<string, ResourceMetadata> | ObservationResult;

/** Normalized form every consumer works with. Both maps always present. */
export interface NormalizedObservation {
  resources: Record<string, ResourceMetadata>;
  unobserved: Record<string, UnobservedEntity>;
}

/** True when `value` is the versioned {@link ObservationResult} envelope. */
export function isObservationResult(value: unknown): value is ObservationResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { observation?: unknown }).observation === "v1"
  );
}

/**
 * Build an {@link ObservationResult}. Lexicons use this rather than writing the
 * discriminant by hand.
 */
export function observation(
  resources: Record<string, ResourceMetadata>,
  unobserved?: Record<string, UnobservedEntity>,
): ObservationResult {
  return {
    observation: "v1",
    resources,
    ...(unobserved && Object.keys(unobserved).length > 0 ? { unobserved } : {}),
  };
}

/**
 * Normalize either accepted return shape. `undefined` (a lexicon that returned
 * nothing at all) normalizes to two empty maps — which reads as "everything was
 * observed absent", so callers that mean "the read failed" must say so with
 * {@link unobservedAll} rather than returning nothing.
 */
export function normalizeObservation(value: DescribeResourcesResult | undefined): NormalizedObservation {
  if (!value) return { resources: {}, unobserved: {} };
  if (isObservationResult(value)) {
    return { resources: value.resources ?? {}, unobserved: value.unobserved ?? {} };
  }
  return { resources: value, unobserved: {} };
}

/**
 * Mark every named entity NOT-OBSERVED with one reason — the whole-lexicon
 * failure case (the provider CLI is missing, the cluster binding refused, the
 * credentials are gone). Core applies this when `describeResources()` throws,
 * so a thrown read degrades to an honest "did not look" for each declared
 * entity instead of an empty map that classifies as N creates.
 */
export function unobservedAll(
  names: Iterable<string>,
  reason: UnobservedReason,
  detail?: string,
  types?: Map<string, { entityType: string }> | Record<string, string>,
): Record<string, UnobservedEntity> {
  const typeOf = (name: string): string | undefined => {
    if (!types) return undefined;
    if (types instanceof Map) return types.get(name)?.entityType;
    return types[name];
  };
  const out: Record<string, UnobservedEntity> = {};
  for (const name of names) {
    const type = typeOf(name);
    out[name] = { reason, ...(type ? { type } : {}), ...(detail ? { detail } : {}) };
  }
  return out;
}

/**
 * Union several observations of the same lexicon (the multi-stack read, where
 * `describeResources` runs once per stack). Precedence is
 * present > not-observed > absent: a resource found in any stack is present; an
 * entity nobody could look at stays not-observed; an entity every reader looked
 * for and did not find is absent.
 */
export function mergeObservations(parts: Iterable<NormalizedObservation>): NormalizedObservation {
  const resources: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  for (const part of parts) {
    Object.assign(resources, part.resources);
    Object.assign(unobserved, part.unobserved);
  }
  // Present wins: a stack that could not be read does not un-observe a resource
  // another stack returned.
  for (const name of Object.keys(resources)) delete unobserved[name];
  return { resources, unobserved };
}

/** One-line human phrasing of a reason, for CLI output. */
export function unobservedReasonText(reason: UnobservedReason): string {
  switch (reason) {
    case "read-failed":
      return "read failed";
    case "no-credentials":
      return "no credentials";
    case "no-binding":
      return "no binding for this environment";
    case "unsupported-kind":
      return "no reader for this resource kind";
    case "filtered":
      return "withheld by the --owned filter";
  }
}

/** `name — reason (detail)`, the shared rendering for CLI and plan output. */
export function formatUnobserved(name: string, entry: UnobservedEntity): string {
  const base = `${name}${entry.type ? ` (${entry.type})` : ""} — ${unobservedReasonText(entry.reason)}`;
  return entry.detail ? `${base}: ${entry.detail}` : base;
}
