/**
 * Groups of components a capability plans and applies as one (ws-107, #4440).
 *
 * A pull request's components plan and apply one by one, wave by wave
 * (`planPrSet`, `runFanOut`). A capability that declares `planGroup` and
 * `runGroup` (./capability.ts) can take several of them in one call instead,
 * so a value one member creates reaches the members that read it inside the
 * same apply, with no round in between.
 *
 * Core decides which components form a group, where the group sits among the
 * waves, what its digest binds and what each member's outcome means. The
 * capability decides how. Nothing here names a lexicon.
 *
 * - {@link findComponentGroups}: which components of the change group, and
 *   why each other one that could have did not (ws-107, "Which components
 *   form a group"). Called once by `pr.ts`'s prepare step.
 * - {@link groupFanOut}: the fan-out with each group in one wave (ws-107,
 *   "Where the group sits"). The plan stage, the apply stage and every
 *   `--wave-gate` job read these waves.
 * - {@link planComponentGroup}: plan a group in one call, and fold the group
 *   digest into each member's plan digest ({@link bindGroup}).
 * - {@link runComponentGroup}: apply it in one call, and turn each member's
 *   outcome into a component result.
 */

import { computePlanDigest } from "../lifecycle/plan-digest";
import type { ChangeSetPart } from "../change-set";
import type { PlanShape } from "./covered-round";
import {
  accumulateComponentOutputs,
  assertTargetsAccepted,
  resolveStepInput,
  unresolvedWiringSources,
  wiringReads,
  wiringReferencesAt,
  type DriverComponent,
  type DriverComponentResult,
  type DriverPhase,
  type DriverStep,
} from "./driver";
import {
  isPlanMovedError,
  type Capability,
  type CapabilityGroupOutcome,
  type CapabilityPlan,
  type CapabilityRegistry,
  type DeployContext,
  type GroupContext,
  type GroupFallback,
  type GroupMember,
  type GroupMemberStatus,
  type GroupRead,
  type GroupRun,
  type PlannedOutputs,
  type ReportedGroupRead,
} from "./capability";
import type { FanOutGroup, FanOutGroupFallback, FanOutPlan } from "./fan-out";
import { bindTargets, type WaveComponentPlan } from "./wave-plan";

/** Whether a capability declares the pair; one with only one of the two never gets a group (ws-107). */
function groupsCapable(capability: Capability<never, unknown>): boolean {
  return typeof capability.planGroup === "function" && typeof capability.runGroup === "function";
}

/** Every step a composition declares, gates included, each with the phase it sits in. */
function declaredSteps(phases: readonly DriverPhase[]): Array<{ phase: string; step: DriverStep }> {
  const out: Array<{ phase: string; step: DriverStep }> = [];
  const walk = (phase: string, steps: DriverPhase["steps"]): void => {
    for (const step of steps) {
      if (typeof (step as DriverPhase).phase === "string" && Array.isArray((step as DriverPhase).steps)) {
        walk((step as DriverPhase).phase, (step as DriverPhase).steps);
        continue;
      }
      out.push({ phase, step: step as DriverStep });
    }
  };
  for (const phase of phases) walk(phase.phase, phase.steps);
  return out;
}

/**
 * The step of `component` a group capability would take, if any: the first
 * capability step whose capability declares the pair, and whether it is the
 * component's only step, gates counted (ruling 3).
 */
function groupStepOf(component: DriverComponent, registry: CapabilityRegistry): { kind: string; phase: string; step: DriverStep; only: boolean; steps: number } | undefined {
  const steps = declaredSteps(component.deploy);
  const at = steps.find(({ step }) => step.kind !== "gate" && registry.has(step.kind) && groupsCapable(registry.resolve(step.kind)));
  if (!at) return undefined;
  return { kind: at.step.kind, phase: at.phase, step: at.step, only: steps.length === 1, steps: steps.length };
}

/** The components whose outputs `component`'s steps read, its own left out. */
function readSources(component: DriverComponent): Set<string> {
  const out = new Set<string>();
  for (const { step } of declaredSteps(component.deploy)) {
    if (step.kind === "gate") continue;
    const { kind: _kind, ...rest } = step;
    for (const r of wiringReads(rest, {})) if (r.source !== component.name) out.add(r.source);
  }
  return out;
}

/** The sets `names` falls into when `joined` links two of them, each in the order of `names`. */
function connected(names: readonly string[], joined: (a: string, b: string) => boolean): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const start of names) {
    if (seen.has(start)) continue;
    const set = new Set([start]);
    seen.add(start);
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.shift()!;
      for (const other of names) {
        if (seen.has(other) || !joined(at, other)) continue;
        seen.add(other);
        set.add(other);
        queue.push(other);
      }
    }
    out.push(names.filter((n) => set.has(n)));
  }
  return out;
}

/** Each component's transitive `dependsOn`, with the `extra` upstreams a capability reported (#4447), memoised. */
function upstreamsOf(byName: ReadonlyMap<string, DriverComponent>, extra: ReadonlyMap<string, ReadonlySet<string>> = new Map()): (name: string) => ReadonlySet<string> {
  const memo = new Map<string, Set<string>>();
  const of = (name: string): Set<string> => {
    const known = memo.get(name);
    if (known) return known;
    const out = new Set<string>();
    memo.set(name, out);
    for (const dep of [...(byName.get(name)?.dependsOn ?? []), ...(extra.get(name) ?? [])]) {
      out.add(dep);
      for (const up of of(dep)) out.add(up);
    }
    return out;
  };
  return of;
}

/** The 1-based wave of each component in `waves`. */
function waveNumbers(waves: readonly string[][]): Map<string, number> {
  const out = new Map<string, number>();
  waves.forEach((wave, i) => wave.forEach((name) => out.set(name, i + 1)));
  return out;
}

/**
 * Each component's wave once every group in `groups` is one unit (ws-107,
 * "Where the group sits"), or `undefined` when the units' dependencies form
 * a cycle. A group's wave is the earliest in which everything its members
 * depend on outside it has applied, and never before the earliest wave any
 * member had. A component outside every group keeps its wave unless a
 * dependency now sits in its wave or after it and got there by a group: a
 * group, or a component a group moved.
 */
function placeUnits(plan: FanOutPlan, byName: ReadonlyMap<string, DriverComponent>, groups: readonly FanOutGroup[]): Map<string, number> | undefined {
  const inChange = new Set(plan.order);
  const was = waveNumbers(plan.waves);
  const unitOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const g of groups) for (const c of g.components) unitOf.set(c, `group:${g.components[0]}`);
  for (const c of plan.order) {
    if (!unitOf.has(c)) unitOf.set(c, c);
    const u = unitOf.get(c)!;
    members.set(u, [...(members.get(u) ?? []), c]);
  }
  const isGroup = (u: string): boolean => u.startsWith("group:");
  const deps = new Map<string, Set<string>>();
  for (const [u, cs] of members) {
    const out = new Set<string>();
    for (const c of cs) for (const d of byName.get(c)?.dependsOn ?? []) if (inChange.has(d) && unitOf.get(d) !== u) out.add(unitOf.get(d)!);
    deps.set(u, out);
  }
  const wave = new Map<string, number>();
  const moved = new Map<string, boolean>();
  const visiting = new Set<string>();
  const visit = (u: string): number | undefined => {
    const known = wave.get(u);
    if (known !== undefined) return known;
    if (visiting.has(u)) return undefined;
    visiting.add(u);
    const start = Math.min(...members.get(u)!.map((c) => was.get(c) ?? 1));
    let w = start;
    for (const d of deps.get(u)!) {
      const dw = visit(d);
      if (dw === undefined) return undefined;
      if (dw < w) continue;
      if (isGroup(u) || isGroup(d) || moved.get(d)) w = dw + 1;
    }
    visiting.delete(u);
    wave.set(u, w);
    moved.set(u, w !== start || isGroup(u));
    return w;
  };
  for (const u of members.keys()) if (visit(u) === undefined) return undefined;
  return new Map(plan.order.map((c) => [c, wave.get(unitOf.get(c)!)!]));
}

export interface FindComponentGroupsOptions {
  /** Every component in the project. */
  components: DriverComponent[];
  /** The fan-out the change derives (`planFanOut`). Only `order` is grouped. */
  plan: FanOutPlan;
  registry: CapabilityRegistry;
  env: string;
  vars?: Record<string, unknown>;
  /**
   * Only components that share one of these groups may join (#4446): a
   * resume forms groups again over what is left of the approved ones
   * ({@link regroupRemaining}), never new ones.
   */
  within?: readonly FanOutGroup[];
}

/** What {@link findComponentGroups} found, for {@link groupFanOut}. */
export interface FoundComponentGroups {
  /** In plan order of their first member, each member list upstreams first. */
  groups: FanOutGroup[];
  /** Sorted by component. */
  fallbacks: FanOutGroupFallback[];
}

/** The reads of `self`'s step input of other members of `group`, sorted by `ref` (ws-107). */
function groupReadsOf(input: Record<string, unknown>, group: ReadonlySet<string>, self: string): GroupRead[] {
  return wiringReferencesAt(input)
    .filter((r) => r.source !== self && group.has(r.source))
    .map((r) => ({ at: r.at, ref: r.ref, component: r.source, output: r.output }));
}

/** The outputs in `outputs` of components outside `group`. */
function outsideOf(outputs: Record<string, Record<string, unknown>>, group: ReadonlySet<string>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(outputs).filter(([name]) => !group.has(name)));
}

/**
 * The `GroupMember`s of `group` (ws-107). With `outputs`, each input is
 * resolved against the outputs from outside the group and the context names
 * only outside components as unresolved; without, as `groupFallback` asks,
 * there is no input. Throws when a member cannot narrow to its targets.
 */
function groupMembers(
  group: FanOutGroup,
  byName: ReadonlyMap<string, DriverComponent>,
  registry: CapabilityRegistry,
  ctxOf: (component: string) => DeployContext,
  outputs?: Record<string, Record<string, unknown>>,
): GroupMember[] {
  const inGroup = new Set(group.components);
  const outside = outputs ? outsideOf(outputs, inGroup) : undefined;
  return group.components.map((name) => {
    const component = byName.get(name);
    const at = component ? groupStepOf(component, registry) : undefined;
    if (!component || !at) throw new Error(`${name} has no ${group.capability} step to plan in its group`);
    const { kind: _kind, ...step } = at.step;
    const base = ctxOf(name);
    assertTargetsAccepted(component, registry, base);
    const reads = groupReadsOf(step, inGroup, name);
    const dependsOn = component.dependsOn?.length ? { dependsOn: [...component.dependsOn] } : {};
    if (!outside) return { component: name, step, reads, ...dependsOn, ctx: base };
    const unresolved = unresolvedWiringSources(step, outside).filter((source) => !inGroup.has(source));
    return {
      component: name,
      step,
      input: resolveStepInput(step, {}, outside),
      reads,
      ...dependsOn,
      ctx: unresolved.length > 0 ? { ...base, unresolvedInputs: unresolved } : base,
    };
  });
}

function groupContext(group: FanOutGroup, env: string, vars?: Record<string, unknown>): GroupContext {
  return { env, ...(vars ? { vars } : {}), components: [...group.components] };
}

/**
 * The reads each capability with `groupReads` reports among the change's
 * components whose step it takes (#4447): only reads between two such
 * components of one capability, never of a component by itself. A
 * capability that throws reports none.
 */
async function reportedReads(
  order: readonly string[],
  kindOf: (name: string) => string | undefined,
  byName: ReadonlyMap<string, DriverComponent>,
  options: FindComponentGroupsOptions,
  ctxOf: (component: string) => DeployContext,
): Promise<ReportedGroupRead[]> {
  const out: ReportedGroupRead[] = [];
  const kinds = [...new Set(order.map(kindOf).filter((k): k is string => k !== undefined))];
  for (const kind of kinds) {
    const capability = options.registry.resolve(kind);
    if (typeof capability.groupReads !== "function") continue;
    const names = order.filter((name) => kindOf(name) === kind);
    if (names.length < 2) continue;
    const all: FanOutGroup = { capability: kind, components: names };
    let reported: ReportedGroupRead[];
    try {
      reported = await capability.groupReads(groupContext(all, options.env, options.vars), groupMembers(all, byName, options.registry, ctxOf) as never);
    } catch {
      continue;
    }
    const inKind = new Set(names);
    for (const r of reported ?? []) {
      if (r.reader !== r.upstream && inKind.has(r.reader) && inKind.has(r.upstream)) out.push({ ...r });
    }
  }
  return out.sort((a, b) => a.reader.localeCompare(b.reader) || a.ref.localeCompare(b.ref) || a.upstream.localeCompare(b.upstream));
}

/** `set` with each member after every member of it that it reads or depends on, else in the order of `set`. */
function upstreamsFirst(set: readonly string[], upstreams: (name: string) => ReadonlySet<string>): string[] {
  const out: string[] = [];
  const left = [...set];
  while (left.length > 0) {
    const i = left.findIndex((m) => left.every((o) => o === m || !upstreams(m).has(o)));
    // A cycle among the members keeps the order of `set` for the rest.
    const [next] = left.splice(i < 0 ? 0 : i, 1);
    out.push(next!);
  }
  return out;
}

/** The reads of `reads` between two members of `components`. */
function readsWithin(reads: readonly ReportedGroupRead[], components: readonly string[]): ReportedGroupRead[] {
  const inGroup = new Set(components);
  return reads.filter((r) => inGroup.has(r.reader) && inGroup.has(r.upstream));
}

/**
 * The groups among the components of the change (ws-107):
 *
 * 1. A component is eligible when its deploy is one step, gates counted
 *    (ruling 3), whose capability declares `planGroup` and `runGroup`.
 * 2. Eligible components of one capability joined by reads, in either
 *    direction, form a candidate set. A read is a wiring reference in a
 *    step, or one the capability reports through `groupReads` (#4447); a
 *    reported read also counts as a dependency below, orders the members
 *    and is kept on the group as its `reads`.
 * 3. While a component outside a set lies on a `dependsOn` path between two
 *    of its members, the members downstream of it leave the set, and both
 *    parts are joined by reads again (ruling 2). Outside components are
 *    taken in plan order.
 * 4. A set of one is no group. Each other set is offered to its
 *    capability's `groupFallback`. A fallback without `drop` dissolves it.
 *    One with `drop` leaves those members out (#4419 ruling 1): the rest
 *    are joined by reads and split by rule 3 again, a member left on its
 *    own falls back as `alone` (or `split`, when a dependency path split
 *    it off), and each set that is left is offered again.
 * 5. A group whose placement would put it and another each before the other
 *    is dissolved (`cycle`).
 *
 * The fallbacks name every component whose capability declares the pair,
 * that a read joins to another such component of its capability, and that
 * ended in no group: `steps`, `split`, `alone`, `cycle`, or the capability's
 * own kind.
 */
export async function findComponentGroups(options: FindComponentGroupsOptions): Promise<FoundComponentGroups> {
  const byName = new Map(options.components.map((c) => [c.name, c]));
  const order = options.plan.order.filter((name) => byName.has(name));
  const steps = new Map<string, NonNullable<ReturnType<typeof groupStepOf>>>();
  for (const name of order) {
    const at = groupStepOf(byName.get(name)!, options.registry);
    if (at) steps.set(name, at);
  }
  const ctxOf = (component: string): DeployContext => ({ env: options.env, component, ...(options.vars ? { vars: options.vars } : {}) });
  const reported = await reportedReads(order, (name) => steps.get(name)?.kind, byName, options, ctxOf);
  const sources = new Map(order.map((name) => [name, readSources(byName.get(name)!)]));
  const extra = new Map<string, Set<string>>();
  for (const r of reported) {
    sources.get(r.reader)!.add(r.upstream);
    extra.set(r.reader, (extra.get(r.reader) ?? new Set()).add(r.upstream));
  }
  const reads = (a: string, b: string): boolean => sources.get(a)!.has(b) || sources.get(b)!.has(a);
  const sameKind = (a: string, b: string): boolean => steps.get(a)?.kind === steps.get(b)?.kind;
  const withinOf = options.within ? groupsByComponent({ groups: [...options.within] }) : undefined;
  const together = (a: string, b: string): boolean => !withinOf || (withinOf.get(a) !== undefined && withinOf.get(a) === withinOf.get(b));
  const joined = (a: string, b: string): boolean => sameKind(a, b) && reads(a, b) && together(a, b);
  const fallbacks = new Map<string, FanOutGroupFallback>();
  const fallBack = (component: string, kind: string, reason: string): void => {
    if (!fallbacks.has(component)) fallbacks.set(component, { component, capability: steps.get(component)!.kind, kind, reason });
  };

  const eligible = order.filter((name) => steps.get(name)?.only === true);
  for (const name of order) {
    const at = steps.get(name);
    if (!at || at.only) continue;
    if (eligible.some((other) => joined(name, other))) {
      fallBack(name, "steps", `${name} deploys in ${at.steps} steps, and only a component whose deploy is one ${at.kind} step joins a group`);
    }
  }

  const upstreams = upstreamsOf(byName, extra);
  const below = (name: string, of: string): boolean => upstreams(name).has(of);
  /** `start` split while a component outside a set lies on a `dependsOn` path between two of its members (ruling 2), and what split each member. */
  const split = (start: string[][]): { sets: string[][]; by: Map<string, string> } => {
    let sets = start;
    const by = new Map<string, string>();
    for (let changed = true; changed; ) {
      changed = false;
      const next: string[][] = [];
      for (const set of sets) {
        const inSet = new Set(set);
        const between = order.find((x) => !inSet.has(x) && set.some((m) => below(x, m)) && set.some((m) => below(m, x)));
        if (between === undefined) {
          next.push(set);
          continue;
        }
        changed = true;
        for (const m of set) by.set(m, between);
        const down = set.filter((m) => below(m, between));
        const up = set.filter((m) => !below(m, between));
        next.push(...connected(up, joined), ...connected(down, joined));
      }
      sets = next;
    }
    return { sets, by };
  };
  const splitReason = (only: string, by: string | undefined): string =>
    `${by ?? "a component outside the group"} lies on a dependency path between ${only} and the rest of its group, and a group applies in one call`;

  const joinedSets = connected(eligible, joined);
  const partnered = new Set(joinedSets.filter((s) => s.length > 1).flat());
  const first = split(joinedSets);
  const candidates: string[][] = [];
  for (const set of first.sets) {
    if (set.length > 1) {
      candidates.push(set);
      continue;
    }
    const [only] = set;
    if (only !== undefined && partnered.has(only)) fallBack(only, "split", splitReason(only, first.by.get(only)));
  }

  const taken: FanOutGroup[] = [];
  // Each set formed again after a drop goes to the front, so groups are still taken in plan order of their first member.
  const queue = [...candidates];
  while (queue.length > 0) {
    const set = queue.shift()!;
    const components = upstreamsFirst(set, upstreams);
    const within = readsWithin(reported, components);
    const group: FanOutGroup = { capability: steps.get(set[0]!)!.kind, components, ...(within.length > 0 ? { reads: within } : {}) };
    const capability = options.registry.resolve(group.capability);
    let refused: GroupFallback | undefined;
    if (capability.groupFallback) {
      try {
        refused = await capability.groupFallback(groupContext(group, options.env, options.vars), groupMembers(group, byName, options.registry, ctxOf) as never);
      } catch (err) {
        refused = { kind: "error", reason: `${group.capability} could not say whether it takes the group: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (refused) {
      const inSet = new Set(set);
      const drops = (refused.drop ?? []).filter((d) => inSet.has(d.component));
      if (drops.length === 0) {
        for (const m of set) fallBack(m, refused.kind, refused.reason);
        continue;
      }
      // Ruling 1: only the dropped members leave; the rest form again by the same rules and are asked again.
      for (const d of drops) fallBack(d.component, d.kind ?? refused.kind, d.reason ?? refused.reason);
      const gone = new Set(drops.map((d) => d.component));
      const again = split(connected(set.filter((m) => !gone.has(m)), joined));
      for (const s of again.sets) {
        const [only] = s;
        if (s.length > 1 || only === undefined) continue;
        const by = again.by.get(only);
        if (by !== undefined) fallBack(only, "split", splitReason(only, by));
        else fallBack(only, "alone", `${only} is the only member of its group left once ${[...gone].join(", ")} fell back, and a group of one is no group`);
      }
      queue.unshift(...again.sets.filter((s) => s.length > 1));
      continue;
    }
    // Placed in plan order of the first member; a group that would close a cycle with those before it is dissolved.
    if (placeUnits(options.plan, byName, [...taken, group]) === undefined) {
      for (const m of set) fallBack(m, "cycle", `placing ${set.join(", ")} as one would put it and another group each before the other`);
      continue;
    }
    taken.push(group);
  }

  return { groups: taken, fallbacks: [...fallbacks.values()].sort((a, b) => a.component.localeCompare(b.component)) };
}

/**
 * `plan` with each group of `found` in one wave (ws-107). The members leave
 * their waves for the group's, upstreams first; a component outside every
 * group moves to a later wave when a dependency now sits in its own wave or
 * after it. A wave left empty stays, so wave numbers and their gates keep
 * their meaning, and waves may be added at the end. `digest` does not change.
 */
export function groupFanOut(plan: FanOutPlan, components: DriverComponent[], found: FoundComponentGroups): FanOutPlan {
  const fallbacks = found.fallbacks.length > 0 ? { fallbacks: found.fallbacks } : {};
  const { groups: _groups, fallbacks: _fallbacks, ...bare } = plan;
  if (found.groups.length === 0) return { ...bare, ...fallbacks };
  const byName = new Map(components.map((c) => [c.name, c]));
  const placed = placeUnits(plan, byName, found.groups);
  if (!placed) throw new Error(`groupFanOut: the groups ${found.groups.map((g) => g.components.join(", ")).join("; ")} form a cycle`);
  const total = Math.max(plan.waves.length, ...placed.values());
  const waves: string[][] = Array.from({ length: total }, () => []);
  for (const name of plan.order) waves[placed.get(name)! - 1]!.push(name);
  return { ...bare, order: waves.flat(), waves, groups: found.groups, ...fallbacks };
}

/** `group` with only its members in `inPlan`, and the reported reads between them. */
function keptOf(group: FanOutGroup, inPlan: ReadonlySet<string>): FanOutGroup {
  const { reads, ...rest } = group;
  const components = group.components.filter((c) => inPlan.has(c));
  const within = readsWithin(reads ?? [], components);
  return { ...rest, components, ...(within.length > 0 ? { reads: within } : {}) };
}

/**
 * `plan`, a narrowing of a grouped fan-out (`remainingFanOut`, a round),
 * with what is left of `groups` placed again: each group keeps its members
 * that are still in `plan`, and one left with fewer than two is no group.
 * Nothing is asked of the capability again.
 */
export function narrowGroups(plan: FanOutPlan, components: DriverComponent[], groups: readonly FanOutGroup[] | undefined): FanOutPlan {
  if (!groups || groups.length === 0) return plan;
  const inPlan = new Set(plan.order);
  const kept = groups.map((g) => keptOf(g, inPlan)).filter((g) => g.components.length > 1);
  const byName = new Map(components.map((c) => [c.name, c]));
  if (kept.length === 0 || placeUnits(plan, byName, kept) === undefined) return plan;
  return groupFanOut(plan, components, { groups: kept, fallbacks: plan.fallbacks ?? [] });
}

/**
 * `plan`, what a resume left of a grouped fan-out (`remainingFanOut`), with
 * groups formed again over it (ws-107, "Resume"; #4446). Only members left
 * of one of `groups` group again, by the same rule and the same
 * `groupFallback`, so what is left of a group plans as a smaller group, or
 * one by one when fewer than two are left, when they no longer join by
 * reads, or when the capability refuses them. A capability that drops some
 * members leaves the rest to group again as {@link findComponentGroups}
 * does. The fallbacks are the ones this
 * pass found, then those of `fallbacks` for components still in `plan`.
 */
export async function regroupRemaining(
  options: Omit<FindComponentGroupsOptions, "within"> & { groups: readonly FanOutGroup[] | undefined; fallbacks?: readonly FanOutGroupFallback[] },
): Promise<FanOutPlan> {
  const inPlan = new Set(options.plan.order);
  const left = (options.groups ?? []).map((g) => keptOf(g, inPlan)).filter((g) => g.components.length > 1);
  const found: FoundComponentGroups =
    left.length > 0
      ? await findComponentGroups({
          components: options.components,
          plan: options.plan,
          registry: options.registry,
          env: options.env,
          ...(options.vars ? { vars: options.vars } : {}),
          within: left,
        })
      : { groups: [], fallbacks: [] };
  const named = new Set(found.fallbacks.map((f) => f.component));
  const fallbacks = [...found.fallbacks, ...(options.fallbacks ?? []).filter((f) => inPlan.has(f.component) && !named.has(f.component))].sort((a, b) =>
    a.component.localeCompare(b.component),
  );
  return groupFanOut(options.plan, options.components, { groups: found.groups, fallbacks });
}

/** The group each component of `plan` is a member of. */
export function groupsByComponent(plan: Pick<FanOutPlan, "groups">): Map<string, FanOutGroup> {
  return new Map((plan.groups ?? []).flatMap((g) => g.components.map((c) => [c, g] as const)));
}

/**
 * The group digest (ws-107): over the capability's kind, each member's
 * component, change-set member and own plan digest, sorted, and the
 * capability's digest of the composition. One member more, or the same
 * members composed differently, moves it.
 */
export function groupDigest(kind: string, members: ReadonlyArray<{ component: string; member: string; planDigest: string }>, composition: string): string {
  const sorted = [...members]
    .map((m) => ({ component: m.component, member: m.member, planDigest: m.planDigest }))
    .sort((a, b) => a.component.localeCompare(b.component) || a.member.localeCompare(b.member));
  return computePlanDigest("capability-group", { kind, members: sorted, composition });
}

/**
 * A member's plan with its group folded in (ws-107), after `bindTargets`:
 * its digest becomes the digest over its own and the group's, written into
 * its change-set part too, and the part carries the group's digest and the
 * `reads` the plan does not know. A plan with no part gets an empty one.
 */
export function bindGroup(planned: CapabilityPlan, digest: string, reads: readonly string[]): CapabilityPlan {
  const planDigest = computePlanDigest("capability-group-member", { plan: planned.planDigest, group: digest });
  const group = { digest, reads: [...new Set(reads)].sort() };
  const part: ChangeSetPart = planned.changeSet ?? {
    member: { member: planned.member, lexicon: "chant", planner: "chant", status: "planned", planDigest, holes: [] },
    entries: [],
  };
  return { ...planned, planDigest, changeSet: { ...part, member: { ...part.member, planDigest, group } } };
}

/** `value` at the dotted `path`. */
function atPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]), value);
}

/**
 * Whether a reported read (#4447) is known at plan: its `output` in the
 * upstream's planned outputs, or, without one, an upstream plan that names
 * outputs and none of them unknown.
 */
function knownAtPlan(outputs: PlannedOutputs | undefined, output: string | undefined): boolean {
  if (!outputs) return false;
  if (output !== undefined) return atPath(outputs.known, output) !== undefined;
  return outputs.unknown.length === 0;
}

/** What planning a group gave (ws-107). */
export interface ComponentGroupPlan {
  /**
   * One per member, in the group's order, as `planWaveComponent` gives a
   * component's: its member, part, planned outputs and shape, its plan under
   * `plans`. When the group failed to plan, each is that error.
   */
  plans: WaveComponentPlan[];
  /** The group digest folded into each member's. Absent when it failed to plan. */
  digest?: string;
  /** What `runGroup` gets back. Absent when it failed to plan. */
  run?: GroupRun;
}

export interface PlanComponentGroupOptions {
  group: FanOutGroup;
  components: ReadonlyMap<string, DriverComponent>;
  registry: CapabilityRegistry;
  env: string;
  vars?: Record<string, unknown>;
  /** Each member's context, as a single step would get it. */
  ctxOf: (component: string) => DeployContext;
  /** The outputs planned and read so far. The group's own members' are left out. */
  outputs: Record<string, Record<string, unknown>>;
}

/**
 * Plan `group` with one `planGroup` call (ws-107). Each member's plan is
 * bound to its targets (`bindTargets`), then to the group ({@link bindGroup}).
 * Never throws: a failure, a throwing `planGroup` included, makes every
 * member plan-failed with its error, and nothing falls back after planning.
 */
export async function planComponentGroup(options: PlanComponentGroupOptions): Promise<ComponentGroupPlan> {
  const { group } = options;
  const failAll = (err: unknown): ComponentGroupPlan => {
    const error = err instanceof Error ? err.message : String(err);
    return { plans: group.components.map((component) => ({ component, error })) };
  };
  try {
    const capability = options.registry.resolve(group.capability);
    if (!groupsCapable(capability)) throw new Error(`${group.capability} does not plan and apply a group`);
    const members = groupMembers(group, options.components, options.registry, options.ctxOf, options.outputs);
    const planned = await capability.planGroup!(groupContext(group, options.env, options.vars), members as never);
    const bound = new Map<string, CapabilityPlan>();
    for (const m of members) {
      const own = planned.members[m.component];
      if (!own) throw new Error(`${group.capability} planned the group ${group.components.join(", ")} without a plan for ${m.component}`);
      bound.set(m.component, bindTargets(group.capability, m.ctx, own));
    }
    const digest = groupDigest(
      group.capability,
      members.map((m) => ({ component: m.component, member: bound.get(m.component)!.member, planDigest: bound.get(m.component)!.planDigest })),
      planned.digest,
    );
    const plans: WaveComponentPlan[] = [];
    const runPlans: Record<string, CapabilityPlan> = {};
    for (const m of members) {
      const own = bound.get(m.component)!;
      // A read the upstream member's plan does not know is computed by the group's apply.
      const unknown = [
        ...m.reads.filter((r) => atPath(planned.members[r.component]?.outputs?.known, r.output) === undefined).map((r) => r.ref),
        ...(group.reads ?? []).filter((r) => r.reader === m.component && !knownAtPlan(planned.members[r.upstream]?.outputs, r.output)).map((r) => r.ref),
      ];
      const plan = bindGroup(own, digest, unknown);
      runPlans[m.component] = plan;
      const shapes: Record<string, PlanShape> | undefined = own.shape ? { [plan.member]: { ...own.shape, member: plan.member } } : undefined;
      plans.push({
        component: m.component,
        members: [{ member: plan.member, planDigest: plan.planDigest }],
        plans: { [plan.member]: plan },
        parts: [plan.changeSet!],
        ...(own.outputs ? { outputs: own.outputs } : {}),
        ...(shapes ? { shapes } : {}),
      });
    }
    return { plans, digest, run: { ...(planned.artifact !== undefined ? { artifact: planned.artifact } : {}), digest, plans: runPlans } };
  } catch (err) {
    return failAll(err);
  }
}

export interface RunComponentGroupOptions {
  group: FanOutGroup;
  components: ReadonlyMap<string, DriverComponent>;
  registry: CapabilityRegistry;
  env: string;
  vars?: Record<string, unknown>;
  /** Each member's context as a single step would get it, without `plans`. */
  ctxOf: (component: string) => DeployContext;
  /** The approved group plan ({@link ComponentGroupPlan.run}). */
  run: GroupRun | undefined;
  /** The outputs standing. Each member that applied adds its own, as a run does. */
  componentOutputs: Record<string, Record<string, unknown>>;
}

export interface ComponentGroupRunResult {
  /** One per member, in the group's order. A `not-started` member's is `fail` with a `skipped` record. */
  results: DriverComponentResult[];
  /** The members whose part never began, in the group's order. */
  notStarted: string[];
  /**
   * How each member's part ended, as the capability said (#4446): the
   * report's `groupOutcome`. A throw gives every member `failed`, or
   * `not-started` for a moved plan.
   */
  outcomes: Record<string, GroupMemberStatus>;
}

/**
 * Apply `group` with one `runGroup` call (ws-107) and map each member's
 * outcome: `applied` and `no-changes` complete it and record its outputs;
 * `partial` and `failed` fail it; `not-started` leaves it not started. A
 * throw fails every member, since core cannot tell what applied, except a
 * moved plan (`isPlanMovedError`), which leaves every member not started and
 * marks each record `planMoved`, so the command exits 3.
 */
export async function runComponentGroup(options: RunComponentGroupOptions): Promise<ComponentGroupRunResult> {
  const { group } = options;
  const start = Date.now();
  const phaseOf = (name: string): string => {
    const component = options.components.get(name);
    return (component && groupStepOf(component, options.registry)?.phase) ?? "Apply";
  };
  const record = (name: string, body: Partial<DriverComponentResult["records"][number]> & { status: DriverComponentResult["records"][number]["status"] }) => ({
    component: name,
    phase: phaseOf(name),
    kind: group.capability,
    durationMs: Date.now() - start,
    ...body,
  });
  const everyMember = (status: "failed" | "not-started", error: string, planMoved = false): ComponentGroupRunResult => ({
    results: group.components.map((name) => ({
      component: name,
      ok: false,
      status: "fail" as const,
      records: [record(name, { status: status === "failed" ? "fail" : "skipped", error, ...(planMoved ? { planMoved: true as const } : {}) })],
    })),
    notStarted: status === "not-started" ? [...group.components] : [],
    outcomes: Object.fromEntries(group.components.map((name) => [name, status])),
  });

  let outcome: CapabilityGroupOutcome;
  try {
    if (!options.run) throw new Error(`no approved plan of the group ${group.components.join(", ")} to apply`);
    const capability = options.registry.resolve(group.capability);
    if (!groupsCapable(capability)) throw new Error(`${group.capability} does not plan and apply a group`);
    const run = options.run;
    const ctxOf = (component: string): DeployContext => {
      const plan = run.plans[component];
      return { ...options.ctxOf(component), ...(plan ? { plans: { [plan.member]: plan } } : {}) };
    };
    const members = groupMembers(group, options.components, options.registry, ctxOf, options.componentOutputs);
    outcome = await capability.runGroup!(groupContext(group, options.env, options.vars), run, members as never);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return isPlanMovedError(err) ? everyMember("not-started", `not started: ${error}`, true) : everyMember("failed", error);
  }

  const results: DriverComponentResult[] = [];
  const notStarted: string[] = [];
  const outcomes: Record<string, GroupMemberStatus> = {};
  for (const name of group.components) {
    const o = outcome.members[name] ?? { status: "failed" as const, error: outcome.error ?? `${group.capability} said nothing of ${name}'s part` };
    outcomes[name] = o.status;
    if (o.status === "applied" || o.status === "no-changes") {
      if (o.outputs) accumulateComponentOutputs(options.componentOutputs, name, { [phaseOf(name)]: { outputs: o.outputs } });
      results.push({ component: name, ok: true, status: "ok", records: [record(name, { status: "ok", output: o })] });
      continue;
    }
    if (o.status === "not-started") {
      notStarted.push(name);
      results.push({ component: name, ok: false, status: "fail", records: [record(name, { status: "skipped", error: o.error ?? "not started: the group's apply stopped before its part began" })] });
      continue;
    }
    const error = o.error ?? outcome.error ?? `${name}'s part of the group ${o.status === "partial" ? "applied in part" : "failed"}`;
    results.push({ component: name, ok: false, status: "fail", records: [record(name, { status: "fail", error })] });
  }
  return { results, notStarted, outcomes };
}
