/**
 * assertLive (#1857) — the read half of the test harness (#1224):
 * observation-backed assertions against a live deploy, for exactly one
 * declared entity at a time. Same primitive teardown.ts's fallback path
 * uses — `describeResources` — turned into a pass/throw instead of a
 * would-delete set.
 *
 * The observation contract (#1089) draws a hard line between OBSERVED-ABSENT
 * and NOT-OBSERVED: a declared entity the read could not cover is never the
 * same as one confirmed missing. `assertLiveEntity` preserves that line by
 * construction — NOT-OBSERVED throws {@link UnobservedAssertionError}, a type
 * distinct from the {@link LiveAssertionError} an observed-absent, foreign,
 * or status-mismatched verdict throws, so a caller can tell "could not tell"
 * from "confirmed wrong" without parsing a message.
 *
 * Marker verification is best-effort by the same logic {@link
 * ResourceMetadata.marker}'s own contract states: a lexicon with no marker
 * channel on this read path (aws's thin `describeResources`, `ownership:
 * "unknown"`) reports no marker at all, which is not the same claim as
 * "foreign". Enforcing a match whenever the channel exists — a present
 * mismatch, or `ownership: "foreign"` with no marker to show — catches the
 * case the harness cares about (a same-named leftover from another env);
 * an absent channel is passed through unverified rather than making every
 * lexicon without one unusable.
 */

import { normalizeObservation, unobservedAll, unobservedReasonText, type UnobservedReason } from "../observation";
import type { ObservationLexicon, ResourceMetadata } from "../lexicon";
import type { OwnershipMarker } from "../ownership";

/**
 * Thrown by {@link assertLiveEntity} for a confirmed failure: observed
 * absent, a marker that names another stack/env, a resource confirmed
 * foreign, or a status mismatch. Never thrown for NOT-OBSERVED — see {@link
 * UnobservedAssertionError}.
 */
export class LiveAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveAssertionError";
  }
}

/**
 * Thrown when the entity is NOT-OBSERVED (#1089) rather than confirmed
 * present or absent. Kept as its own type, not a flag on {@link
 * LiveAssertionError}: a suite (or a CI policy) that wants to fail loudly on
 * "could not tell" but treat it differently from a confirmed miss can catch
 * this one specifically.
 */
export class UnobservedAssertionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly reason: UnobservedReason,
    public readonly detail?: string,
  ) {
    super(
      `assertLive("${entity}") is NOT-OBSERVED — ${unobservedReasonText(reason)}` +
        `${detail ? `: ${detail}` : ""}. An entity chant could not read is never the same as one confirmed absent.`,
    );
    this.name = "UnobservedAssertionError";
  }
}

export interface AssertLiveOptions {
  /** Expected `ResourceMetadata.status`, where the lexicon reports one. Skipped when omitted. */
  status?: string;
}

export interface AssertLiveEntityOptions extends AssertLiveOptions {
  plugin: ObservationLexicon;
  /** chant entity name — the key to assert on. */
  name: string;
  entityType: string;
  props: Record<string, unknown>;
  /** This lexicon's own built output for the deploy, or `""` when none was built. */
  buildOutput: string;
  environment: string;
  /** This deploy's identity — the marker an observed resource is checked against. */
  marker: OwnershipMarker;
}

/** True when `meta` names a different stack/env than `marker`, on whichever signal it carries. */
function isConfirmedForeign(meta: ResourceMetadata, marker: OwnershipMarker): boolean {
  if (meta.marker) return meta.marker.stack !== marker.stack || meta.marker.env !== marker.env;
  return meta.ownership === "foreign";
}

/**
 * Assert one declared entity is live: observed present in `environment`, not
 * a confirmed-foreign resource, and — when `status` is given — reporting
 * that status. Resolves to the entity's {@link ResourceMetadata} on success.
 *
 * Throws {@link UnobservedAssertionError} for NOT-OBSERVED. Throws {@link
 * LiveAssertionError} for observed-absent, a confirmed-foreign identity, or a
 * status mismatch.
 */
export async function assertLiveEntity(opts: AssertLiveEntityOptions): Promise<ResourceMetadata> {
  const { plugin, name, entityType, props, buildOutput, environment, marker, status } = opts;

  if (!plugin.describeResources) {
    throw new UnobservedAssertionError(
      name,
      "unsupported-kind",
      `the "${plugin.name}" lexicon implements no describeResources`,
    );
  }

  let observed;
  try {
    observed = normalizeObservation(
      await plugin.describeResources({
        environment,
        buildOutput,
        entityNames: [name],
        entities: new Map([[name, { entityType, props }]]),
      }),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    observed = {
      resources: {},
      unobserved: unobservedAll([name], "read-failed", detail, { [name]: entityType }),
      queried: {},
      notes: [],
    };
  }

  const unobserved = observed.unobserved[name];
  if (unobserved) throw new UnobservedAssertionError(name, unobserved.reason, unobserved.detail);

  const meta = observed.resources[name];
  if (!meta) {
    throw new LiveAssertionError(
      `assertLive("${name}"): observed absent — chant looked and "${environment}" reported no such resource.`,
    );
  }

  if (isConfirmedForeign(meta, marker)) {
    const found = meta.marker ? `{ stack: "${meta.marker.stack}", env: "${meta.marker.env ?? ""}" }` : "no chant marker";
    throw new LiveAssertionError(
      `assertLive("${name}"): observed, but it is not this deploy's — carries ${found}, not ` +
        `{ stack: "${marker.stack}", env: "${marker.env ?? ""}" }. A same-named resource from another stack or env cannot satisfy this assertion.`,
    );
  }

  if (status !== undefined && meta.status !== status) {
    throw new LiveAssertionError(
      `assertLive("${name}", { status: "${status}" }): observed with status "${meta.status}".`,
    );
  }

  return meta;
}
