/**
 * Fan a change out downstream, in an order derived from the source (#2417).
 *
 * The order was never the missing piece. `resolveComponentGraph` (./driver.ts)
 * already Kahn-layers a component set by `dependsOn` into parallel-safe waves,
 * flattens to a topological order, refuses a cycle by name and refuses a
 * `dependsOn` it has not been given. What it cannot do is order a *subset*:
 * hand it the affected components alone and it throws `UnknownDependencyError`,
 * because a selected component still names a dependency that is not in the set.
 *
 * That is what this module is. Given every component in the project and the
 * ones whose inputs moved, it derives who else has to run, in what order, what
 * has to be seeded because it is deliberately not running, and one digest that
 * identifies the whole derivation so a single gate can be bound to it.
 *
 * ## Why derived rather than declared
 *
 * The competing shape is a registry where you write down that component B
 * depends on component A. That registry is a second statement of a relationship
 * the source already makes, and it is wrong the first time somebody adds a
 * reference without updating it. `dependsOn` is in the component; the graph is
 * a walk over it.
 *
 * ## Three outcomes, never two
 *
 * A component is selected, skipped as unaffected, or **indeterminate** — the
 * same third answer `../lifecycle/affected.ts` already refuses to collapse. A
 * component whose inputs arrive at deploy time cannot be judged from a source
 * diff, so it is reported rather than guessed at in either direction. Fanning
 * out to everything on any change is easy to build, worth nothing, and reads
 * exactly like diligence in a log.
 *
 * This plans; it does not run. Executing the plan is ./driver.ts's job.
 */

import { resolveComponentGraph, type DriverComponent } from "./driver";
import { deployUnits } from "./deploy-units";
import { computePlanDigest } from "../lifecycle/plan-digest";

/** Thrown when `changed` or `indeterminate` names a component the project does not have. */
export class UnknownComponentError extends Error {
  constructor(
    readonly field: "changed" | "indeterminate",
    readonly component: string,
    known: string[],
  ) {
    super(
      `${field} names "${component}", which is not a component in this project ` +
        `(known: ${known.join(", ") || "none"})`,
    );
    this.name = "UnknownComponentError";
  }
}

/** Why a component is in the plan but not running. */
export type FanOutSkipReason =
  /** Nothing it depends on moved, and it did not move itself. */
  | "unaffected"
  /** Its inputs arrive at deploy time, so a source diff cannot judge it. */
  | "indeterminate"
  /** It already applied in an earlier attempt at this same fan-out. */
  | "already-applied"
  /** Something it depends on failed, so the value it would read never landed. */
  | "blocked";

export interface FanOutSkip {
  component: string;
  reason: FanOutSkipReason;
  /** For `blocked`, the failed component the walk reached this one from. */
  blockedBy?: string;
}

export interface FanOutRequest {
  /** Every component in the project, `dependsOn` intact. The full graph is what makes a subset orderable. */
  components: DriverComponent[];
  /** Components whose own inputs moved. The walk starts here. */
  changed: string[];
  /**
   * Components a source diff cannot judge (`../lifecycle/affected.ts`'s third
   * category). One that the walk reaches anyway is selected like any other
   * dependent — reachability is a fact about the graph, not about whether the
   * component's own inputs could be read. One the walk does not reach is
   * reported, never decided.
   */
  indeterminate?: string[];
  /**
   * Per-component input identity, when the caller has it. Folded into
   * {@link FanOutPlan.digest} so an approval is bound to *what* would be
   * applied and not only to who would run. Absent, the digest still identifies
   * the derivation — the selection, the order and the edges it came from.
   */
  inputDigests?: Record<string, string>;
}

export interface FanOutPlan {
  /** The components to run, every dependency before its dependents. */
  order: string[];
  /**
   * Parallel-safe waves over the selected set. A dependency that is not
   * selected is already satisfied — its outputs are seeded — so it does not
   * hold its dependents back a wave.
   */
  waves: string[][];
  /** Components deliberately not running, with why. Sorted by name. */
  skipped: FanOutSkip[];
  /**
   * Dependencies of selected components that are not themselves selected.
   * Their outputs have to be seeded for a reference to resolve, which is the
   * price of running a subset rather than the whole graph.
   */
  seeds: string[];
  /** Components a source diff could not judge and the walk did not reach. Reported, never decided. */
  indeterminate: string[];
  /** Identity of this derivation, for binding one approval to the whole fan-out (#2300's pattern). */
  digest: string;
}

/** Reverse the `dependsOn` edges: who has to re-run when this one moves. */
function consumersOf(components: DriverComponent[]): Map<string, string[]> {
  const consumers = new Map<string, string[]>();
  for (const c of components) {
    for (const dep of c.dependsOn ?? []) {
      const existing = consumers.get(dep);
      if (existing) existing.push(c.name);
      else consumers.set(dep, [c.name]);
    }
  }
  return consumers;
}

/**
 * Derive the fan-out for a change.
 *
 * Refuses a cycle and an unknown `dependsOn` before selecting anything, by
 * resolving the **full** graph first — a broken graph is a broken graph whether
 * or not the change happens to touch the broken part, and finding out halfway
 * through a fan-out is worse than finding out before it starts.
 */
export function planFanOut(request: FanOutRequest): FanOutPlan {
  const { components, changed, indeterminate = [], inputDigests } = request;

  // Refuses DependencyCycleError / UnknownDependencyError over the whole graph.
  // Its `order` is deliberately not used: `topoSort` walks in declaration
  // order, so two projects with the same graph and a different file layout
  // would derive different-looking fan-outs and digest differently. The waves
  // below are canonical, and this plan's order is their flattening.
  resolveComponentGraph(components);

  const byName = new Map(components.map((c) => [c.name, c]));
  for (const name of changed) {
    if (!byName.has(name)) throw new UnknownComponentError("changed", name, [...byName.keys()].sort());
  }
  for (const name of indeterminate) {
    if (!byName.has(name)) throw new UnknownComponentError("indeterminate", name, [...byName.keys()].sort());
  }

  // Everything reachable downstream of a changed component, transitively. A
  // component reached by two paths is added once, which is the diamond case.
  const consumers = consumersOf(components);
  const selected = new Set<string>(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const consumer of consumers.get(node) ?? []) {
      if (selected.has(consumer)) continue;
      selected.add(consumer);
      queue.push(consumer);
    }
  }

  // Waves over the selected subgraph only. An unselected dependency is already
  // applied, so it is not a reason for its dependents to wait.
  const remaining = new Set(selected);
  const selectedDeps = new Map(
    [...selected].map((name) => [name, new Set((byName.get(name)!.dependsOn ?? []).filter((d) => selected.has(d)))]),
  );
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((n) => [...selectedDeps.get(n)!].every((d) => !remaining.has(d)))
      .sort();
    // resolveComponentGraph already refused every cycle in the full graph, and
    // a subgraph of an acyclic graph is acyclic, so this cannot stall.
    for (const n of wave) remaining.delete(n);
    waves.push(wave);
  }

  // Every dependency lands in an earlier wave than its dependents, so the
  // flattening is a topological order, and a sorted one.
  const order = waves.flat();

  const seeds = [
    ...new Set(order.flatMap((name) => (byName.get(name)!.dependsOn ?? []).filter((d) => !selected.has(d)))),
  ].sort();

  const unreachedIndeterminate = indeterminate.filter((name) => !selected.has(name)).sort();
  const indeterminateSet = new Set(unreachedIndeterminate);
  const skipped: FanOutSkip[] = [...byName.keys()]
    .filter((name) => !selected.has(name))
    .sort()
    .map((component) => ({
      component,
      reason: indeterminateSet.has(component) ? ("indeterminate" as const) : ("unaffected" as const),
    }));

  // What the approver is approving: who runs, in what order, off which edges,
  // and — when the caller knows it — what each one would apply. Never the run
  // id or the moment, per ../lifecycle/plan-digest.ts's rules, so re-deriving
  // an unchanged fan-out does not expire an approval.
  const digest = computePlanDigest("component-fan-out", {
    order,
    waves,
    seeds,
    edges: order.map((name) => ({ component: name, dependsOn: [...(byName.get(name)!.dependsOn ?? [])].sort() })),
    ...(inputDigests
      ? { inputs: order.map((name) => ({ component: name, digest: inputDigests[name] ?? null })) }
      : {}),
  });

  return { order, waves, skipped, seeds, indeterminate: unreachedIndeterminate, digest };
}

// ── Joining the change signal to components ──────────────────────────────────

/**
 * `../lifecycle/affected.ts`'s answer, which is about **stacks**.
 *
 * `AffectedResult` itself is not imported: this takes the two fields the join
 * needs, so a caller can also hand in a signal that did not come from a git
 * diff (a CI system's own changed-paths answer, an operator naming a stack by
 * hand) without manufacturing the rest of that shape.
 */
export interface ChangedUnits {
  /** Stacks whose built artifact moved between base and head. */
  changed: string[];
  /** Stacks a source diff could not judge, because their inputs arrive at deploy time. */
  indeterminate?: string[];
}

/** What {@link componentsForUnits} resolved, ready to hand to {@link planFanOut}. */
export interface ComponentChangeSignal {
  /** Components deploying at least one changed unit. */
  changed: string[];
  /** Components deploying no changed unit but at least one indeterminate one. */
  indeterminate: string[];
  /**
   * Changed or indeterminate units no component claims. Reported rather than
   * dropped: a stack that moved and belongs to nothing this project deploys is
   * a hole in the fan-out's coverage, and a silent one is the failure mode
   * this whole feature exists to avoid.
   */
  unclaimed: string[];
}

/**
 * Join a stack-level change signal to the components that deploy those stacks.
 *
 * The key is `deployUnits` (./deploy-units.ts), which already answers "what
 * live units does this component's composition target" for `chant components
 * status --live`. Reusing it means a component's claim on a stack is stated
 * once, by its deploy steps, rather than restated in a fan-out config — the
 * same argument this module's doc makes about `dependsOn`.
 *
 * Changed beats indeterminate. A component deploying one stack that certainly
 * moved and another that could not be judged is changed: the certainty already
 * decides it, and reporting it as indeterminate would lose that.
 */
export function componentsForUnits(
  components: DriverComponent[],
  units: ChangedUnits,
): ComponentChangeSignal {
  const changedUnits = new Set(units.changed);
  const indeterminateUnits = new Set(units.indeterminate ?? []);

  const changed: string[] = [];
  const indeterminate: string[] = [];
  const claimed = new Set<string>();

  for (const component of components) {
    const names = deployUnits(component.deploy).map((u) => u.unit);
    let touchesChanged = false;
    let touchesIndeterminate = false;
    for (const name of names) {
      if (changedUnits.has(name)) {
        touchesChanged = true;
        claimed.add(name);
      }
      if (indeterminateUnits.has(name)) {
        touchesIndeterminate = true;
        claimed.add(name);
      }
    }
    if (touchesChanged) changed.push(component.name);
    else if (touchesIndeterminate) indeterminate.push(component.name);
  }

  const unclaimed = [...changedUnits, ...indeterminateUnits].filter((u) => !claimed.has(u));

  return {
    changed: changed.sort(),
    indeterminate: indeterminate.sort(),
    unclaimed: [...new Set(unclaimed)].sort(),
  };
}

// ── Finishing a fan-out that stopped ─────────────────────────────────────────

export interface FanOutProgress {
  /** Components that reached `ok` in an earlier attempt at this same plan. */
  completed?: string[];
  /** Components that failed. Everything downstream of one is blocked, not failed. */
  failed?: string[];
}

/**
 * Narrow a plan to what still has to run.
 *
 * **The digest does not change.** That is the whole point: an operator approved
 * a fan-out, a component in the middle of it failed, and finishing the work
 * they already approved must not ask them to approve it again. `remainingFanOut`
 * returns the same `digest` the original derivation produced, so the standing
 * resolution still satisfies the gate on the next attempt. Re-deriving with
 * {@link planFanOut} would mint a new identity and invalidate the approval,
 * which is why resume narrows a plan rather than recomputing one.
 *
 * **A component beneath a failure is `blocked`, never `failed`.** Nothing about
 * it failed. It did not run because the value it would have read never landed,
 * and the distinction is what makes the next attempt legible: an operator
 * reading `blocked by "cluster-a"` knows to fix one thing, not fourteen.
 *
 * **Independent branches keep going.** The order was derived from the source,
 * so a branch that shares no edge with the failure is *known* to be independent
 * rather than assumed to be. Stopping it is the conservative-looking choice
 * that throws away the reason for deriving the graph in the first place.
 */
export function remainingFanOut(
  plan: FanOutPlan,
  components: DriverComponent[],
  progress: FanOutProgress,
): FanOutPlan {
  const byName = new Map(components.map((c) => [c.name, c]));
  const planned = new Set(plan.order);
  const completed = new Set((progress.completed ?? []).filter((n) => planned.has(n)));
  const failed = new Set((progress.failed ?? []).filter((n) => planned.has(n)));

  // Everything downstream of a failure, within the plan, and who blocked it.
  const consumers = consumersOf(components);
  const blockedBy = new Map<string, string>();
  // Sorted, so a component downstream of two separate failures always names the
  // same one. Unsorted, the report would depend on the order the caller listed
  // the failures in, which is not a fact about anything.
  const queue = [...failed].sort();
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const consumer of consumers.get(node) ?? []) {
      if (!planned.has(consumer) || failed.has(consumer) || blockedBy.has(consumer)) continue;
      // Named for the failure the walk reached it from, so the report points at
      // the thing to fix rather than at the nearest edge.
      blockedBy.set(consumer, failed.has(node) ? node : blockedBy.get(node)!);
      queue.push(consumer);
    }
  }

  const runnable = new Set(
    plan.order.filter((n) => !completed.has(n) && !failed.has(n) && !blockedBy.has(n)),
  );

  // Re-layer what is left. A dependency that already applied is satisfied, so
  // it does not hold its dependents back — the same rule the original
  // derivation applies to a dependency outside the selection.
  const remaining = new Set(runnable);
  const deps = new Map(
    [...runnable].map((n) => [n, new Set((byName.get(n)?.dependsOn ?? []).filter((d) => runnable.has(d)))]),
  );
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining].filter((n) => [...deps.get(n)!].every((d) => !remaining.has(d))).sort();
    for (const n of wave) remaining.delete(n);
    waves.push(wave);
  }
  const order = waves.flat();

  // A completed component's outputs have to be seeded for a reference to
  // resolve, exactly like a component that was never selected.
  const seeds = [
    ...new Set([
      ...plan.seeds,
      ...order.flatMap((n) => (byName.get(n)?.dependsOn ?? []).filter((d) => !runnable.has(d))),
    ]),
  ].sort();

  const carried = plan.skipped.filter((s) => !runnable.has(s.component));
  const skipped: FanOutSkip[] = [
    ...carried,
    ...[...completed].sort().map((component) => ({ component, reason: "already-applied" as const })),
    ...[...blockedBy.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([component, by]) => ({ component, reason: "blocked" as const, blockedBy: by })),
  ].sort((a, b) => a.component.localeCompare(b.component));

  return { order, waves, skipped, seeds, indeterminate: plan.indeterminate, digest: plan.digest };
}
