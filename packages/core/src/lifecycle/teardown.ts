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
 * The execution half is {@link executeTeardown}: it drives each lexicon's
 * `executeTeardown` capability over the planned set, then runs one bounded
 * retry pass over the failures. Both halves are exported as functions —
 * #1224's test-env harness calls them in-process, not only through the verb.
 */

import { normalizeObservation, unobservedAll } from "../observation";
import type { ObservationLexicon, TeardownCandidate, TeardownHole, TeardownOutcome } from "../lexicon";
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
  /**
   * Every deployed stack a multi-stack project declares (`stacks` in
   * chant.config), for a lexicon whose teardown is stack-shaped (aws
   * enumerates and deletes whole stacks). Forwarded to `teardownOwned` /
   * `executeTeardown` as `stacks`.
   */
  deployedStacks?: Array<{ name: string; region?: string }>;
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
          ...(opts.deployedStacks && opts.deployedStacks.length > 0 ? { stacks: opts.deployedStacks } : {}),
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

/** One planned entry's fate after execution, attributed to its lexicon. */
export interface TeardownOutcomeEntry extends TeardownPlanEntry {
  /**
   * `skipped` is core's verdict for a candidate whose lexicon implements no
   * `executeTeardown` yet; the other three come from the lexicon (see
   * {@link TeardownOutcome}).
   */
  outcome: "deleted" | "failed" | "not-prunable" | "skipped";
  /** The error for `failed`, the reason for `not-prunable`/`skipped`. */
  detail?: string;
  /** True when this final outcome came from the bounded retry pass. */
  retried?: boolean;
}

/** What `chant lifecycle teardown <env> --yes` prints and #1224 consumes. */
export interface TeardownReport {
  environment: string;
  stack: string;
  /** The plan that was executed — holes and skipped lexicons included. */
  plan: TeardownPlan;
  /** One row per planned entry. Never fewer: silence is never success. */
  outcomes: TeardownOutcomeEntry[];
  /** Lexicons whose candidates were skipped for lack of an `executeTeardown`. */
  unimplemented: string[];
}

export interface ExecuteTeardownOptions extends PlanTeardownOptions {
  /**
   * A plan already computed (the one just shown to the user). Recomputed from
   * a fresh live read when omitted.
   */
  plan?: TeardownPlan;
}

/**
 * Run one execution pass over a lexicon's candidates and return exactly one
 * outcome per candidate: what the lexicon reported, `failed` for anything it
 * stayed silent about, and `failed` across the board when the call threw.
 * Outcomes the lexicon volunteers for names core never asked about are
 * dropped — an implementation cannot widen the set by reporting on it.
 */
async function executePass(
  plugin: ObservationLexicon,
  candidates: TeardownCandidate[],
  opts: ExecuteTeardownOptions,
  marker: OwnershipMarker,
): Promise<Map<string, TeardownOutcome>> {
  const byName = new Map<string, TeardownOutcome>();
  let reported: TeardownOutcome[];
  try {
    const execution = await plugin.executeTeardown!({
      environment: opts.environment,
      marker,
      candidates,
      ...(opts.deployedStack ? { stack: opts.deployedStack } : {}),
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.deployedStacks && opts.deployedStacks.length > 0 ? { stacks: opts.deployedStacks } : {}),
    });
    reported = execution.outcomes;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    for (const candidate of candidates) {
      byName.set(candidate.name, { name: candidate.name, outcome: "failed", detail });
    }
    return byName;
  }
  const asked = new Set(candidates.map((c) => c.name));
  for (const outcome of reported) {
    if (!asked.has(outcome.name)) continue;
    byName.set(outcome.name, outcome);
  }
  for (const candidate of candidates) {
    if (byName.has(candidate.name)) continue;
    byName.set(candidate.name, {
      name: candidate.name,
      outcome: "failed",
      detail: "the lexicon reported no outcome for this candidate",
    });
  }
  return byName;
}

/**
 * Execute a teardown: delete every planned candidate through its lexicon's
 * `executeTeardown`, then retry the failures once. Per-lexicon ordering only —
 * each lexicon deletes its own set in the order its target requires (k8s
 * deletes namespaces last, fly deletes apps last); there is no global
 * reverse-dependency ordering in v1, the bounded retry pass covers the
 * cross-lexicon cases it would.
 *
 * Every planned entry comes back with an outcome. A lexicon that enumerates
 * but implements no execution reports its candidates as `skipped` — loudly,
 * never as clean. Failures that survive the retry stay `failed` in the
 * report; nothing here ever swallows one.
 */
export async function executeTeardown(opts: ExecuteTeardownOptions): Promise<TeardownReport> {
  const marker: OwnershipMarker = { stack: opts.stack, env: opts.environment };
  const plan = opts.plan ?? (await planTeardown(opts));

  const byLexicon = new Map<string, TeardownPlanEntry[]>();
  for (const entry of plan.entries) {
    const list = byLexicon.get(entry.lexicon) ?? [];
    list.push(entry);
    byLexicon.set(entry.lexicon, list);
  }

  const outcomes: TeardownOutcomeEntry[] = [];
  const unimplemented: string[] = [];

  // Plugin registration order, so a project's lexicon ordering is stable.
  for (const plugin of opts.plugins) {
    const entries = byLexicon.get(plugin.name);
    if (!entries) continue;
    byLexicon.delete(plugin.name);

    if (!plugin.executeTeardown) {
      unimplemented.push(plugin.name);
      for (const entry of entries) {
        outcomes.push({
          ...entry,
          outcome: "skipped",
          detail: `the ${plugin.name} lexicon does not implement teardown execution yet`,
        });
      }
      continue;
    }

    const candidates: TeardownCandidate[] = entries.map(({ lexicon: _lexicon, ...candidate }) => candidate);
    const first = await executePass(plugin, candidates, opts, marker);

    // One bounded retry pass over this lexicon's failures — transient errors
    // and ordering hiccups get a second chance, nothing gets an infinite one.
    const failedNames = new Set(
      [...first.values()].filter((o) => o.outcome === "failed").map((o) => o.name),
    );
    const retried =
      failedNames.size > 0
        ? await executePass(plugin, candidates.filter((c) => failedNames.has(c.name)), opts, marker)
        : new Map<string, TeardownOutcome>();

    for (const entry of entries) {
      const second = retried.get(entry.name);
      const outcome = second ?? first.get(entry.name)!;
      outcomes.push({
        ...entry,
        outcome: outcome.outcome,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        ...(second !== undefined ? { retried: true } : {}),
      });
    }
  }

  // A planned entry attributed to a lexicon that is not in `plugins` at
  // execution time (a plan handed in from elsewhere). Nobody can delete it,
  // and silence is never success.
  for (const entries of byLexicon.values()) {
    for (const entry of entries) {
      outcomes.push({
        ...entry,
        outcome: "skipped",
        detail: `no loaded lexicon named "${entry.lexicon}" to execute this candidate`,
      });
    }
  }

  outcomes.sort((a, b) => a.lexicon.localeCompare(b.lexicon) || a.name.localeCompare(b.name));
  return { environment: opts.environment, stack: opts.stack, plan, outcomes, unimplemented };
}
