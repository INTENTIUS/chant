/**
 * Teardown planning (#1222) — the enumeration half of
 * `chant lifecycle teardown <env>`.
 *
 * Answers one question: which live resources carry THIS project's ownership
 * marker for THIS environment? Selection is marker-scoped by construction —
 * managed-by present, stack equal to the project's `ownership.stack`, env
 * equal to the argument — so a foreign stack's resources, another env's
 * resources, and unmarked resources are out of scope by shape, not by
 * filtering discipline someone has to remember.
 *
 * Stateless: live markers only. No build, no snapshot, no ledger — the
 * ownership record lives on the cloud resource (see ../ownership.ts), and this
 * module reads it back from there.
 *
 * Two paths per lexicon:
 * - the `teardownOwned` capability, where the lexicon enumerates its own
 *   would-delete set (and can use a read shaped for deletion — aws's
 *   stack-level path, k8s's prune selector);
 * - a fallback over `describeResources` + the {@link ResourceMetadata.marker}
 *   field (#1222 PR 1), for lexicons that have not implemented the capability
 *   yet. Best-effort: a lexicon whose thin read only resolves declared names
 *   returns nothing here, which the plan reports as a skip, not as clean.
 *
 * Whichever path ran, core re-checks every candidate's marker and drops
 * mismatches — an implementation bug can narrow the set, never widen it.
 *
 * Deletion does not happen anywhere in this module. The execution half is a
 * later PR (#1222); #1224's test-env harness will call {@link planTeardown}
 * in-process, which is why it is exported as a function and not only a verb.
 */

import { normalizeObservation, unobservedAll } from "../observation";
import type { ObservationLexicon, TeardownCandidate, TeardownHole } from "../lexicon";
import type { OwnershipMarker } from "../ownership";

/** One would-delete row in a teardown plan, attributed to its lexicon. */
export interface TeardownPlanEntry extends TeardownCandidate {
  lexicon: string;
}

/** One hole in a teardown plan (#1089), attributed to its lexicon. */
export interface TeardownPlanHole extends TeardownHole {
  lexicon: string;
}

/** The plan `chant lifecycle teardown <env>` prints and #1224 consumes. */
export interface TeardownPlan {
  environment: string;
  /** The project's ownership stack — the identity everything was selected on. */
  stack: string;
  /** The would-delete set. Every entry's marker equals `{ stack, env: environment }`. */
  entries: TeardownPlanEntry[];
  /** What could not be read (#1089). A plan with holes is incomplete, not clean. */
  holes: TeardownPlanHole[];
  /**
   * Lexicons that took part in neither path — no `teardownOwned`, no
   * `describeResources`. Reported so "nothing to delete" can never quietly
   * mean "nobody looked".
   */
  skipped: string[];
}

export interface PlanTeardownOptions {
  /** The environment being torn down — the marker env to select on. */
  environment: string;
  /** This project's ownership stack (`ownership.stack` in chant.config). */
  stack: string;
  plugins: ObservationLexicon[];
  /** Deployed stack name, for a multi-stack project. */
  deployedStack?: string;
  /** Region that stack is deployed in. */
  region?: string;
}

/** True when `marker` is exactly the identity this plan selects on. */
function markerMatches(marker: OwnershipMarker | undefined, stack: string, env: string): boolean {
  return marker !== undefined && marker.stack === stack && marker.env === env;
}

/**
 * Enumerate what `chant lifecycle teardown <env>` would delete. Read-only —
 * this function never deletes and never will; execution composes on top of the
 * plan it returns.
 */
export async function planTeardown(opts: PlanTeardownOptions): Promise<TeardownPlan> {
  const marker: OwnershipMarker = { stack: opts.stack, env: opts.environment };
  const entries: TeardownPlanEntry[] = [];
  const holes: TeardownPlanHole[] = [];
  const skipped: string[] = [];

  for (const plugin of opts.plugins) {
    if (plugin.teardownOwned) {
      let enumeration;
      try {
        enumeration = await plugin.teardownOwned({
          environment: opts.environment,
          marker,
          ...(opts.deployedStack ? { stack: opts.deployedStack } : {}),
          ...(opts.region ? { region: opts.region } : {}),
        });
      } catch (err) {
        // A failed enumeration is a hole over the whole lexicon, not a clean
        // lexicon (#1089): nothing was read, so nothing is known.
        holes.push({
          lexicon: plugin.name,
          name: "*",
          reason: "read-failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      for (const candidate of enumeration.candidates) {
        // Defense in depth: the contract says every candidate carries the
        // requested identity; a candidate that does not is dropped here so an
        // implementation bug cannot widen the delete set.
        if (!markerMatches(candidate.marker, opts.stack, opts.environment)) continue;
        entries.push({ lexicon: plugin.name, ...candidate });
      }
      for (const hole of enumeration.holes ?? []) {
        holes.push({ lexicon: plugin.name, ...hole });
      }
      continue;
    }

    if (plugin.describeResources) {
      let observed;
      try {
        observed = normalizeObservation(
          await plugin.describeResources({
            environment: opts.environment,
            buildOutput: "",
            entityNames: [],
            entities: new Map(),
            owned: true,
            ...(opts.deployedStack ? { stack: opts.deployedStack } : {}),
            ...(opts.region ? { region: opts.region } : {}),
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        observed = {
          resources: {},
          unobserved: unobservedAll(["*"], "read-failed", message),
          queried: {},
          notes: [],
        };
      }
      for (const [name, meta] of Object.entries(observed.resources)) {
        // Marker-scoped by construction: no marker, foreign stack, or foreign
        // env means not a candidate — a resource with no readable identity is
        // never promoted to a delete.
        if (!markerMatches(meta.marker, opts.stack, opts.environment)) continue;
        entries.push({
          lexicon: plugin.name,
          name,
          type: meta.type,
          ...(meta.physicalId ? { physicalId: meta.physicalId } : {}),
          marker: meta.marker!,
        });
      }
      for (const [name, u] of Object.entries(observed.unobserved)) {
        holes.push({
          lexicon: plugin.name,
          name,
          ...(u.type ? { type: u.type } : {}),
          reason: u.reason,
          ...(u.detail ? { detail: u.detail } : {}),
        });
      }
      continue;
    }

    skipped.push(plugin.name);
  }

  entries.sort((a, b) => a.lexicon.localeCompare(b.lexicon) || a.name.localeCompare(b.name));
  return { environment: opts.environment, stack: opts.stack, entries, holes, skipped };
}
