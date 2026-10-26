/**
 * The release gate (#4045, ws-104 questions 2 and 6): the gate `chant
 * components promote --release` passes for an environment.
 *
 * ## What it binds
 *
 * A promote under a release plans the release's change set for the
 * environment it deploys to ({@link planReleaseChangeSet}), stores it on
 * `chant/lifecycle` under its digest (`../lifecycle/gate-change-set.ts`), and
 * decides every gate its components reach against three values:
 *
 * - the change-set document's `digest`, in `planDigest`;
 * - the release, in `releaseDigest`;
 * - the environment, in `environment`.
 *
 * An approval counts only when all three match (`evaluateGate` in
 * `../op/gate.ts`). The document itself names the release and the environment
 * it was planned for, and both are part of its digest, so a stored document
 * names the one release its gate bound and two releases never share a digest.
 *
 * Every gate a promote under a release reaches is recorded in one ledger,
 * {@link RELEASE_GATE_OP}, rather than in each component's. The gate name a
 * composition authors is kept, so components that share a gate name share one
 * gate per environment, and one approval of the release's change set passes
 * each of them. A promote of one component (`--component`) plans that
 * component's subset, which has its own digest and needs its own approval.
 *
 * ## Empty change sets
 *
 * When the change set changes nothing ({@link isEmptyChangeSet}), the
 * promote writes an `empty: true` resolution for each gate, with the actor
 * running it in `resolvedBy` ({@link emptyResolution}). A gate counts it only
 * after it reads the stored document back and finds it empty
 * ({@link emptyVerifier}). Quorum and signing rules don't apply to it.
 *
 * ## The members
 *
 * A component with a step whose capability can plan (`terraform-apply`) is
 * planned by that capability, as a pull request's plan is. A plan that
 * returns no change-set part is a hole, since nothing says what it changes.
 *
 * A dependency the promote also deploys is read from its plan, not from the
 * estate (#4168 step 4, the rule #3999 gave a pull request): a dependent is
 * planned against the outputs its upstream's plan says it will expose, and a
 * reference the plan can't say is listed in `unknownInputs`. Any other
 * dependency is read as it stands. What each component was planned against is
 * kept in `reads`, so the promote can hold it back when an upstream applies
 * as another value (`./promote-rounds.ts`).
 *
 * Any other component is a `chant` member compared with what the
 * environment runs now: its latest deploy record and the release that record
 * names. The artifact digest, each template the release's target records for
 * the component, and the target's parameters are compared, and each one that
 * differs is an attribute of one `update` entry (a `create` when the
 * environment has no deploy of the component). When they are all equal the
 * member has no entries. When the environment's deploy names no release, or
 * the release it names can't be read, the member has a hole: nothing says
 * what the environment runs, so the change can't be shown empty. So does a
 * component a promote, rollback or redeploy left failed or gated with nothing
 * recorded since (#4035): its record names what ran before that run.
 */

import type { CapabilityRegistry, GroupRun, PlannedOutputs } from "./capability";
import type { FanOutGroup, FanOutGroupFallback, FanOutPlan } from "./fan-out";
import { groupsByComponent, planComponentGroup } from "./groups";
import { deployContext, resolveComponentGraph, resolveStepInput, unresolvedWiringReferences, type DriverComponent, type DriverGate, type DriverPhase, type DriverStep } from "./driver";
import { componentPlanDigest } from "./gate-plan";
import { gateName, RELEASE_GATE_OP } from "../op/gate-name";
import { capabilitySteps, planContext, readComponentOutputs } from "./wave-plan";
import {
  composeChangeSet,
  isEmptyChangeSet,
  type ChangeSetAttribute,
  type ChangeSetDocument,
  type ChangeSetPart,
} from "../change-set";
import type { Release } from "../lifecycle/release-store";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import type { GateResolutionInput } from "../lifecycle/gate-ledger";
import type { StoredChangeSetRead } from "../lifecycle/change-set-store";

/** The gate ledger every release gate is recorded in: `_gates/release.jsonl`, under the member's prefix. */
export { RELEASE_GATE_OP };

/** The address and type a `chant` member's one entry has. */
export const RELEASE_COMPONENT_ENTRY_TYPE = "chant:component";

function isGate(step: DriverStep | DriverGate | DriverPhase): step is DriverGate {
  return (step as { kind?: unknown }).kind === "gate";
}

function isPhase(step: DriverStep | DriverGate | DriverPhase): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

/** The name of every gate the compositions declare, nested phases included, sorted and distinct. */
export function gateNamesOf(components: readonly DriverComponent[]): string[] {
  const names = new Set<string>();
  const walk = (steps: DriverPhase["steps"]): void => {
    for (const step of steps) {
      if (isPhase(step)) walk(step.steps);
      else if (isGate(step)) names.add(gateName(step));
    }
  };
  for (const c of components) for (const phase of c.deploy) walk(phase.steps);
  return [...names].sort();
}

/** What an environment runs of one component now: its latest deploy record, and the release that record names when it can be read. */
export interface CurrentDeploy {
  record: ReleaseRecord;
  release: Release | null;
}

export interface ReleaseChangeSetInput {
  release: Release;
  /** The environment promoted to. */
  env: string;
  /** The promoted compositions, with build steps taken out and templates pinned to the release. */
  components: readonly DriverComponent[];
  /** The artifact digest each component is promoted at. */
  digests: ReadonlyMap<string, string>;
  registry: CapabilityRegistry;
  /** Per component, what `env` runs now. A component missing here has never been deployed to it. */
  current: ReadonlyMap<string, CurrentDeploy>;
  /**
   * Components a promote, rollback or redeploy left failed or gated in `env`
   * with nothing recorded since (#4035), each with why. What they run is not
   * known, so each is a hole whatever its ledger record says.
   */
  unsettled?: ReadonlyMap<string, string>;
  /** Outputs supplied by the caller (`--seed-outputs`). */
  seededOutputs?: Record<string, Record<string, unknown>>;
  /** The chant version to record in the document. */
  chant?: string;
  /**
   * Plan only these components (a later round or wave, ./promote-rounds.ts).
   * The others are not planned; a dependency among them is read from
   * `seededOutputs`, which then holds what the run left. Default: every one.
   */
  only?: ReadonlySet<string>;
  /**
   * The promote's grouped fan-out (ws-107, #4465, `formRunGroups`). Each of
   * its groups plans with one `planGroup` call in the wave it places it in,
   * and the group digest is folded into each member's part, so the release
   * gate's digest binds the composition. Absent, or without `groups`: every
   * component plans by itself, wave by wave.
   */
  grouped?: FanOutPlan;
}

/** A group the release gate's plan planned as one (ws-107, #4465). */
export interface ReleasePlanGroup extends FanOutGroup {
  /** The group digest folded into each member's `planDigest`; `null` when the group failed to plan. */
  digest: string | null;
  /** Why the group failed to plan. Every member is then a failed member. */
  error?: string;
  /** What `runGroup` gets back. It lives in the process that planned, as the promote that applies it is. */
  run?: GroupRun;
}

/** A release's change set for an environment, and what each component was planned against. */
export interface ReleasePlan {
  doc: ChangeSetDocument;
  /** Per planned component, the outputs of its dependencies as its plan read them. */
  reads: Record<string, Record<string, Record<string, unknown>>>;
  /** Per dependency read from its plan, the names of the outputs the plan knows, sorted. Absent when none. */
  plannedOutputs?: Record<string, string[]>;
  /** Per component, the references to a promoted upstream that no value stands for until it applies, sorted. Absent when none. */
  unknownInputs?: Record<string, string[]>;
  /** The groups planned as one (#4465), in the order they planned. Absent when none. */
  groups?: ReleasePlanGroup[];
  /** The components that could have grouped and did not, with why: `grouped.fallbacks`. Absent when none. */
  fallbacks?: FanOutGroupFallback[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One attribute per key whose value differs between `before` and `after`, sorted by path. */
function differing(before: Map<string, string>, after: Map<string, string>, prefix: string): ChangeSetAttribute[] {
  const out: ChangeSetAttribute[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort(byString)) {
    const was = before.get(key);
    const now = after.get(key);
    if (was === now) continue;
    out.push({ path: `${prefix}${key}`, ...(was !== undefined ? { before: was } : {}), ...(now !== undefined ? { after: now } : {}) });
  }
  return out;
}

/** What one target says a component deploys: its templates by path, and the target's parameters by name. */
function deployedInputs(release: Release, env: string, component: string): { templates: Map<string, string>; params: Map<string, string> } | null {
  const target = release.targets.find((t) => t.env === env);
  if (!target) return null;
  return {
    templates: new Map(target.templates.filter((t) => t.component === component).map((t) => [t.path, t.digest])),
    params: new Map(target.params.map((p) => [p.name, JSON.stringify(p.value)])),
  };
}

/**
 * A component no capability plans, as a `chant` member: what the release
 * deploys compared with what the environment runs now. See the module doc.
 */
export function chantComponentPart(input: {
  component: DriverComponent;
  release: Release;
  env: string;
  digest: string;
  current: CurrentDeploy | undefined;
  /** Why the component is unsettled in `env` (#4035), when it is. */
  unsettled?: string;
}): ChangeSetPart {
  const { component, release, env, digest, current } = input;
  const name = component.name;
  const member = {
    member: name,
    lexicon: "chant",
    planner: "chant" as const,
    status: "planned" as const,
    planDigest: componentPlanDigest({ environment: env, component, release: digest }),
    holes: [] as Array<{ address: string; type?: string; reason: string }>,
  };
  const want = deployedInputs(release, env, name);
  if (!want) {
    member.holes.push({ address: name, type: RELEASE_COMPONENT_ENTRY_TYPE, reason: `release ${release.releaseDigest} has no target for "${env}"` });
    return { member, entries: [] };
  }
  const entry = (action: "create" | "update", attributes: ChangeSetAttribute[]): ChangeSetPart => ({
    member,
    entries: [
      {
        member: name,
        lexicon: "chant",
        planner: "chant",
        address: name,
        type: RELEASE_COMPONENT_ENTRY_TYPE,
        name,
        action,
        ...(action === "update" ? { disruption: "unknown" as const } : {}),
        scope: env,
        attributes,
      },
    ],
  });
  if (input.unsettled !== undefined) {
    member.holes.push({ address: name, type: RELEASE_COMPONENT_ENTRY_TYPE, reason: input.unsettled });
    return { member, entries: [] };
  }
  if (!current) {
    return entry("create", [
      { path: "artifact", after: digest },
      ...differing(new Map(), want.templates, "template:"),
      ...differing(new Map(), want.params, "param:"),
    ]);
  }
  const named = current.record.releaseDigest;
  if (named === undefined) {
    member.holes.push({
      address: name,
      type: RELEASE_COMPONENT_ENTRY_TYPE,
      reason: `the "${env}" deploy of ${name} (run ${current.record.runId}) names no release, so what it runs can't be compared with this release`,
    });
    return { member, entries: [] };
  }
  const have = current.release ? deployedInputs(current.release, env, name) : null;
  if (!have) {
    member.holes.push({
      address: name,
      type: RELEASE_COMPONENT_ENTRY_TYPE,
      reason: current.release
        ? `release ${named}, which the "${env}" deploy of ${name} names, has no target for "${env}"`
        : `release ${named}, which the "${env}" deploy of ${name} names, can't be read from chant/lifecycle`,
    });
    return { member, entries: [] };
  }
  const attributes = [
    ...differing(new Map([["", current.record.digest]]), new Map([["", digest]]), "artifact"),
    ...differing(have.templates, want.templates, "template:"),
    ...differing(have.params, want.params, "param:"),
  ];
  return attributes.length === 0 ? { member, entries: [] } : entry("update", attributes);
}

/**
 * Plan the release's change set for `env`: one part per promoted component
 * (or per member its planning capability names), composed into a document
 * that names the release and the environment. Never throws for a component
 * that fails to plan: it becomes a failed member.
 */
export async function planReleaseChangeSet(input: ReleaseChangeSetInput): Promise<ChangeSetDocument> {
  return (await planReleaseSet(input)).doc;
}

/**
 * {@link planReleaseChangeSet}, with what each component read. Components are
 * planned a wave at a time, so a dependency the promote deploys has planned
 * before its dependents read its outputs.
 */
export async function planReleaseSet(input: ReleaseChangeSetInput): Promise<ReleasePlan> {
  const { release, env, registry } = input;
  const components = [...input.components];
  const byName = new Map(components.map((c) => [c.name, c]));
  const outputs: Record<string, Record<string, unknown>> = { ...(input.seededOutputs ?? {}) };
  const read = new Set(Object.keys(outputs));
  const parts: ChangeSetPart[] = [];
  const plannedBy = new Map<string, PlannedOutputs | undefined>();
  const planned: Record<string, string[]> = {};
  const unknownInputs: Record<string, string[]> = {};
  const reads: ReleasePlan["reads"] = {};
  const inPlan = (name: string): boolean => input.only === undefined || input.only.has(name);
  const isPlannable = (c: DriverComponent): boolean =>
    capabilitySteps(c.deploy).some((s) => registry.has(s.kind) && registry.resolve(s.kind).plan !== undefined);
  const failedPart = (member: string, err: unknown): ChangeSetPart => ({
    member: {
      member,
      lexicon: "chant",
      planner: "chant",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      planDigest: null,
      holes: [],
    },
    entries: [],
  });
  /** Read each dependency of `component` once, leaving out `mates`, its own group (#4465), and keep what it read. */
  const readDependencies = async (component: DriverComponent, mates: ReadonlySet<string>): Promise<void> => {
    for (const dep of component.dependsOn ?? []) {
      if (mates.has(dep) || read.has(dep) || !byName.has(dep)) continue;
      read.add(dep);
      // A dependency this promote plans exposes what its plan says (#3999).
      if (plannedBy.has(dep) && isPlannable(byName.get(dep)!)) {
        const known = plannedBy.get(dep)?.known ?? {};
        outputs[dep] = { ...known };
        planned[dep] = Object.keys(known).sort();
        continue;
      }
      const found = await readComponentOutputs(byName.get(dep)!, registry, deployContext({ env }, dep), outputs);
      if (found) outputs[dep] = found;
    }
    reads[component.name] = Object.fromEntries(
      (component.dependsOn ?? []).filter((d) => !mates.has(d) && d in outputs).map((d) => [d, structuredClone(outputs[d])]),
    );
  };
  /** The references of `component`'s plannable steps to a promoted upstream outside `mates` that its plan can't say yet. */
  const unknownOf = (component: DriverComponent, mates: ReadonlySet<string>): Set<string> => {
    const unknown = new Set<string>();
    for (const step of capabilitySteps(component.deploy)) {
      if (!registry.has(step.kind) || registry.resolve(step.kind).plan === undefined) continue;
      const { kind: _kind, ...rest } = step;
      for (const r of unresolvedWiringReferences(rest, outputs)) if (plannedBy.has(r.source) && !r.publish && !mates.has(r.source)) unknown.add(r.ref);
    }
    return unknown;
  };

  // ws-107 (#4465): a group plans once, in the wave the grouped fan-out places it in.
  const grouped = input.grouped?.groups?.length ? input.grouped : undefined;
  const groupOf = grouped ? groupsByComponent(grouped) : new Map<string, FanOutGroup>();
  const groups: ReleasePlanGroup[] = [];
  const planGroupAt = async (group: FanOutGroup): Promise<void> => {
    const mates = new Set(group.components);
    try {
      for (const name of group.components) await readDependencies(byName.get(name)!, mates);
    } catch (err) {
      for (const name of group.components) {
        plannedBy.set(name, undefined);
        parts.push(failedPart(name, err));
      }
      groups.push({ ...group, digest: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const g = await planComponentGroup({ group, components: byName, registry, env, ctxOf: (name) => deployContext({ env }, name), outputs });
    const error = g.plans.find((p): p is Extract<typeof p, { error: string }> => "error" in p)?.error;
    groups.push({ ...group, digest: g.digest ?? null, ...(error !== undefined ? { error } : {}), ...(g.run ? { run: g.run } : {}) });
    for (const p of g.plans) {
      if ("error" in p) {
        plannedBy.set(p.component, undefined);
        parts.push(failedPart(p.component, p.error));
        continue;
      }
      plannedBy.set(p.component, p.outputs);
      parts.push(...p.parts);
      const unknown = unknownOf(byName.get(p.component)!, mates);
      if (unknown.size > 0) unknownInputs[p.component] = [...unknown].sort();
    }
  };

  const waves = grouped
    ? grouped.waves.map((w) => w.filter((name) => byName.has(name)))
    : resolveComponentGraph(components.map((c) => ({ ...c, dependsOn: (c.dependsOn ?? []).filter((d) => byName.has(d)) }))).waves;
  for (const wave of waves) {
    const planning = wave.filter(inPlan);
    const inWave = new Set(planning);
    // What is left of a group in this plan; one member alone plans by itself.
    const groupsHere = [...new Set(planning.map((name) => groupOf.get(name)).filter((g): g is FanOutGroup => g !== undefined))]
      .map((g) => ({ ...g, components: g.components.filter((c) => inWave.has(c)) }))
      .filter((g) => g.components.length > 1);
    const grouping = new Set(groupsHere.flatMap((g) => g.components));
    for (const group of groupsHere) await planGroupAt(group);
    for (const name of planning) {
      if (grouping.has(name)) continue;
      const component = byName.get(name)!;
      const digest = input.digests.get(name) ?? "";
      const plannable = capabilitySteps(component.deploy).filter((s) => registry.has(s.kind) && registry.resolve(s.kind).plan !== undefined);
      if (plannable.length === 0) {
        parts.push(chantComponentPart({ component, release, env, digest, current: input.current.get(name), unsettled: input.unsettled?.get(name) }));
        continue;
      }
      const ctx = deployContext({ env }, name);
      try {
        await readDependencies(component, new Set());
        const unknown = unknownOf(component, new Set());
        let exposes: PlannedOutputs | undefined;
        for (const step of plannable) {
          const { kind, ...rest } = step;
          const result = await registry.resolve(kind).plan!(planContext(ctx, rest, outputs), resolveStepInput(rest, {}, outputs) as never);
          if (result.outputs) exposes = { known: { ...(exposes?.known ?? {}), ...result.outputs.known }, unknown: [...new Set([...(exposes?.unknown ?? []), ...result.outputs.unknown])].sort() };
          parts.push(
            result.changeSet ?? {
              member: {
                member: result.member,
                lexicon: "chant",
                planner: "chant",
                status: "planned",
                planDigest: result.planDigest,
                holes: [{ address: result.member, reason: `its ${kind} plan describes no changes, so what it changes is unknown` }],
              },
              entries: [],
            },
          );
        }
        plannedBy.set(name, exposes);
        if (unknown.size > 0) unknownInputs[name] = [...unknown].sort();
      } catch (err) {
        plannedBy.set(name, undefined);
        parts.push(failedPart(name, err));
      }
    }
  }
  const doc = composeChangeSet(parts, {
    ...(input.chant !== undefined ? { chant: input.chant } : {}),
    planned: { releaseDigest: release.releaseDigest, environment: env },
  });
  return {
    doc,
    reads,
    ...(Object.keys(planned).length > 0 ? { plannedOutputs: planned } : {}),
    ...(Object.keys(unknownInputs).length > 0 ? { unknownInputs } : {}),
    ...(groups.length > 0 ? { groups } : {}),
    ...(input.grouped?.fallbacks?.length ? { fallbacks: input.grouped.fallbacks } : {}),
  };
}

/** The members a release gate refuses: provisional ones, which no approval of the document covers (`change-set.mdx`). */
export function provisionalMembers(doc: ChangeSetDocument): string[] {
  return doc.members.filter((m) => m.provisional === true).map((m) => m.member);
}

/**
 * The `verifyEmpty` a release gate decides with: the document stored under
 * the digest, read back and checked against its digest by `read`, is the
 * one planned for this release and environment, and it is empty.
 */
export function emptyVerifier(
  read: (digest: string) => Promise<StoredChangeSetRead>,
  planned: { releaseDigest: string; environment: string },
): (digest: string) => Promise<boolean> {
  return async (digest) => {
    const stored = await read(digest);
    return (
      stored.status === "found" &&
      stored.document.releaseDigest === planned.releaseDigest &&
      stored.document.environment === planned.environment &&
      isEmptyChangeSet(stored.document)
    );
  };
}

/** The `empty: true` resolution a promote writes for one release gate over an empty change set. */
export function emptyResolution(input: {
  gate: string;
  doc: ChangeSetDocument;
  actor: string;
  timestamp: string;
  gitSha?: string;
  runId?: string;
}): GateResolutionInput {
  const { doc } = input;
  if (doc.releaseDigest === undefined || doc.environment === undefined) {
    throw new Error(`change set ${doc.digest} names no release and environment, so no release gate can pass on it`);
  }
  return {
    op: RELEASE_GATE_OP,
    gate: input.gate,
    resolvedBy: input.actor,
    timestamp: input.timestamp,
    note: `the change set of release ${doc.releaseDigest} for "${doc.environment}" is empty`,
    planDigest: doc.digest,
    environment: doc.environment,
    releaseDigest: doc.releaseDigest,
    empty: true,
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  };
}
