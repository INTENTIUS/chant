/**
 * Plan and apply a pull request's members (#3183).
 *
 * `../pr-loop.ts` says what the gate binds and what the report holds; this
 * produces them. Both stages call {@link planPrSet}: the plan stage to show
 * the plan and its digest, the apply stage to plan the same members again
 * before anything applies and decide the gate against what it gets. Planning
 * everything before applying anything is what makes the two digests
 * comparable: each member is planned against the same state both times.
 *
 * ## What a dependent is planned against
 *
 * A member that reads another one's output through `stackOutput()` is
 * planned with one of three values (#3999):
 *
 * - the upstream is in the change too: the value its plan says it will
 *   expose (`CapabilityPlan.outputs`). The report lists these under
 *   `plannedOutputs`.
 * - the upstream is not in the change (#4104): the value it has now, read
 *   through its capability's `outputs` (`readComponentOutputs`). The report
 *   lists these under `deployedOutputs`. A change to one cluster is planned
 *   against the network it sits on, which is why `components` is every
 *   component in the project and not the selection.
 * - the upstream is in the change and its plan cannot say, or says the value
 *   is known only after apply: no value. The dependent's members list the
 *   reference under `unknownInputs`, and the approval does not cover what
 *   it will do with it.
 *
 * `--seed-outputs` wins over both. The apply stage's plan reads the same
 * values, so on the same estate it gets the digest the plan stage showed.
 * A resume plans against the outputs the approved plans read, from the
 * record (`planOutputs`), and reads nothing those cover.
 *
 * ## Planning again once an upstream applied
 *
 * The apply runs each member's approved plan, except a member whose plan
 * read an upstream output that is not the value standing when its turn
 * comes (`movedWiringReferences`): the upstream applied as another value
 * than its plan said, or the value was unknown. That member, and what is
 * downstream of it, is held back. Once the rest settled, the held members
 * are planned again against the outputs the apply left, and that set's
 * digest is decided at its own gate, `<gate>-round-<n>` (`prRoundGate`), as
 * a gated wave decides each wave (#3049). Approved, it applies, and a member
 * that is held again goes to the next round. Not approved, the apply stops
 * `waiting` with the new digest named, and the same apply with its
 * `--resume` record carries on from there.
 *
 * ## Finishing an apply that failed partway
 *
 * {@link resumePrSet} (#3464) is fan-out's resume (#2417, #3049) for a pull
 * request. The attempt record (`./fan-out-record.ts`) keeps the change set
 * the gate approved and the components that applied. A re-run on the same
 * commit narrows the derivation to what is left (`remainingFanOut`), plans
 * only that against the outputs the approved plans read, and checks each
 * member it plans against the approved set. When every one is covered, the
 * gate is decided against the approved digest, which still stands, and only
 * the rest applies. Planning everything again would give the applied members
 * empty plans and the set a new digest, and so ask for a second approval of
 * work already approved.
 *
 * ## A gate per wave on merge
 *
 * `pr-apply --wave-gate` (#4003) applies the approved set a wave at a time.
 * {@link prWavePlan} narrows the derivation to one wave, which is planned
 * against the outputs the waves before it left, and {@link waveNotCovered}
 * says whether the approved change set covers what it planned, by the same
 * test a resume uses ({@link planCoveredBy}). Covered, the wave applies under
 * the pull request's approval; not covered, it needs its own.
 */

import { composeChangeSet, verifyChangeSetDigest, type ChangeSetDocument, type ChangeSetEntry, type ChangeSetPart } from "../change-set";
import { evaluateGate, type GateCheck, type GateLedgerPort } from "../op/gate";
import {
  memberCounts,
  PR_APPLY_GATE,
  prRoundGate,
  PR_REPORT_CONTRACT,
  PR_REPORT_SCHEMA_ID,
  type PrApproval,
  type PrMember,
  type PrRefusal,
  type PrRound,
  type PrReport,
  type PrStatus,
  type PrWave,
} from "../pr-loop";
import {
  deployContext,
  movedWiringReferences,
  unresolvedWiringReferences,
  type DriverComponent,
  type DriverComponentResult,
} from "./driver";
import { deployUnits } from "./deploy-units";
import { runFanOut, type FanOutRunResult } from "./fan-out-run";
import { remainingFanOut, type ComponentChangeSignal, type FanOutPlan } from "./fan-out";
import type { PrApplyRecord } from "./fan-out-record";
import type { CapabilityRegistry, PlannedOutputs } from "./capability";
import type { RunProgressEvent } from "./run-progress";
import type { RunEventSink } from "../run-event-stream";
import { capabilitySteps, planWaveComponent, readDeployedOutputs } from "./wave-plan";

export interface PrPlanSetOptions {
  /** Every component in the project, not the selection: a planned member's dependency outside it is read too (#4104). */
  components: DriverComponent[];
  /** The fan-out the change derives (`planFanOut`). Its `order` is what is planned. */
  plan: FanOutPlan;
  registry: CapabilityRegistry;
  env: string;
  vars?: Record<string, unknown>;
  /** Outputs supplied by the caller (`--seed-outputs`). They win over outputs read here. */
  seededOutputs?: Record<string, Record<string, unknown>>;
  /**
   * Where the planning's events go (#4041): a `plan` phase with no
   * component, and in it one `plan` step per component, started as its wave
   * is planned and settled `ok` or `failed`.
   */
  onRunEvent?: RunEventSink;
}

/** The phase a pull request's planning is, in its run's events. */
export const PR_PLAN_PHASE = "plan";

/** Every member of a pull request, planned. */
export interface PrPlanSet {
  /** The change-set document over every member. Its digest is what the gate binds. */
  doc: ChangeSetDocument;
  members: PrMember[];
  /** Per component, per member: what its steps hand `run`, so it applies this plan. */
  plans: Record<string, Record<string, unknown>>;
  /** The outputs the plans read: the seeds, and each dependency's outputs as they stood. */
  outputs: Record<string, Record<string, unknown>>;
  /**
   * Per dependency read from the deployed estate (#4104), the names of the
   * outputs the read gave, sorted. The seeds are not here. Absent when
   * nothing was read. The report's `deployedOutputs`.
   */
  deployedOutputs?: Record<string, string[]>;
  /**
   * Per dependency in the change that a member read (#3999), the names of
   * the outputs its plan knows, sorted. Absent when there is none. The
   * report's `plannedOutputs`.
   */
  plannedOutputs?: Record<string, string[]>;
  /** Whether any component failed to plan. */
  failed: boolean;
}

/** A failed component's members: the units its steps target, else the component itself. */
function failedParts(component: DriverComponent, error: string): ChangeSetPart[] {
  const units = deployUnits(component.deploy).map((u) => u.unit);
  return (units.length > 0 ? units : [component.name]).map((member) => ({
    member: { member, lexicon: "chant", planner: "chant", status: "failed", error, planDigest: null, holes: [] },
    entries: [],
  }));
}

/**
 * Plan every component in `plan.order`, a wave at a time, each against its
 * dependencies' planned outputs when the change plans them too, and against
 * the outputs they have now otherwise. Never throws for a component that
 * fails to plan: it becomes a failed member, and `failed` is set. Throws
 * when a planned member's dependency is not among `components`, which means
 * the caller passed the selection where the whole graph belongs.
 */
export async function planPrSet(options: PrPlanSetOptions): Promise<PrPlanSet> {
  const byName = new Map(options.components.map((c) => [c.name, c]));
  const outputs: Record<string, Record<string, unknown>> = { ...(options.seededOutputs ?? {}) };
  const read = new Set(Object.keys(outputs));
  const inChange = new Set(options.plan.order);
  /** What each component of the change planned to expose, once its wave planned. */
  const plannedBy = new Map<string, PlannedOutputs | undefined>();
  const deployed: Record<string, string[]> = {};
  const planned: Record<string, string[]> = {};
  const parts: ChangeSetPart[] = [];
  const componentOf = new Map<string, string>();
  const unknownOf = new Map<string, { unknown: string[]; build: string[] }>();
  const plans: Record<string, Record<string, unknown>> = {};
  let failed = false;
  const emit = options.onRunEvent;
  emit?.({ type: "phase-start", component: null, phase: PR_PLAN_PHASE });

  for (const wave of options.plan.waves) {
    // The dependencies' outputs first, each once. One the change plans is
    // read from its plan, which an earlier wave made (#3999). Any other is
    // read from the deployed estate (#4104). A dependency that cannot say
    // leaves its references unresolved, which its dependent's plan reports
    // if it needs them.
    const deps = [...new Set(wave.flatMap((name) => byName.get(name)?.dependsOn ?? []))].filter((dep) => !read.has(dep));
    const fromEstate: string[] = [];
    for (const dep of deps) {
      read.add(dep);
      if (!byName.has(dep)) throw new Error(`planPrSet: ${dep}, a dependency of a planned member, is not among the components; pass every component in the project`);
      if (!inChange.has(dep)) {
        fromEstate.push(dep);
        continue;
      }
      const known = plannedBy.get(dep)?.known ?? {};
      outputs[dep] = { ...known };
      planned[dep] = Object.keys(known).sort();
    }
    Object.assign(deployed, await readDeployedOutputs(fromEstate, byName, options.registry, (dep) => deployContext(options, dep), outputs));
    const results = await Promise.all(
      wave.map(async (name) => {
        const at = { component: name, phase: PR_PLAN_PHASE, step: "plan" };
        emit?.({ type: "step-start", ...at });
        const start = Date.now();
        const p = await planWaveComponent(byName.get(name)!, options.registry, deployContext(options, name), outputs);
        emit?.({
          type: "step-settle",
          ...at,
          status: "error" in p ? "failed" : "ok",
          durationMs: Date.now() - start,
          ...("error" in p ? { error: p.error } : {}),
        });
        return p;
      }),
    );
    for (const p of results) {
      const component = byName.get(p.component)!;
      const unknown = unknownInputsOf(component, outputs, inChange);
      if (unknown.unknown.length > 0 || unknown.build.length > 0) unknownOf.set(p.component, unknown);
      if ("error" in p) {
        failed = true;
        plannedBy.set(p.component, undefined);
        for (const part of failedParts(component, p.error)) {
          parts.push(part);
          componentOf.set(part.member.member, p.component);
        }
        continue;
      }
      plannedBy.set(p.component, p.outputs);
      plans[p.component] = p.plans;
      for (const part of p.parts) {
        parts.push(part);
        componentOf.set(part.member.member, p.component);
      }
    }
  }

  emit?.({ type: "phase-settle", component: null, phase: PR_PLAN_PHASE, status: failed ? "failed" : "ok" });
  const doc = composeChangeSet(parts);
  const members: PrMember[] = doc.members.map((m) => {
    const component = componentOf.get(m.member) ?? m.member;
    const unknown = unknownOf.get(component);
    return {
      member: m.member,
      component,
      planDigest: m.planDigest,
      status: m.status === "failed" ? "plan-failed" : "planned",
      counts: memberCounts(doc, m.member),
      ...(m.error ? { error: m.error } : {}),
      ...(unknown?.unknown.length ? { unknownInputs: unknown.unknown } : {}),
      ...(unknown?.build.length ? { buildInputs: unknown.build } : {}),
    };
  });
  const sorted = (r: Record<string, string[]>) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
  const deployedOutputs = sorted(deployed);
  const plannedOutputs = sorted(planned);
  return {
    doc,
    members,
    plans,
    outputs,
    failed,
    ...(Object.keys(deployedOutputs).length > 0 ? { deployedOutputs } : {}),
    ...(Object.keys(plannedOutputs).length > 0 ? { plannedOutputs } : {}),
  };
}

/**
 * The references `component`'s steps make to an output of a component in
 * the change that `outputs` holds no value for (#3999), known only after
 * that upstream applies, each sorted. `build` are the published artifact
 * identities a build in the change produces (`WiringReference.publish`):
 * the build's provenance binds those, so they are never approved again.
 * `unknown` are the rest.
 */
function unknownInputsOf(
  component: DriverComponent,
  outputs: Record<string, Record<string, unknown>>,
  inChange: ReadonlySet<string>,
): { unknown: string[]; build: string[] } {
  const unknown = new Set<string>();
  const build = new Set<string>();
  for (const step of capabilitySteps(component.deploy)) {
    const { kind: _kind, ...rest } = step;
    for (const r of unresolvedWiringReferences(rest, outputs)) {
      if (inChange.has(r.source)) (r.publish ? build : unknown).add(r.ref);
    }
  }
  return { unknown: [...unknown].sort(), build: [...build].sort() };
}

/**
 * Why `component` cannot apply the plan that read `read` now that `now`
 * stands (#3999): each reference its steps make that resolves to another
 * value, said once. `undefined` when every one resolves as it did. A
 * published artifact's identity from a build in `inChange` never holds a
 * member back: the build's provenance binds it, not this approval.
 */
export function heldReason(
  component: DriverComponent,
  read: Record<string, Record<string, unknown>>,
  now: Record<string, Record<string, unknown>>,
  inChange: ReadonlySet<string> = new Set(),
): string | undefined {
  const refs = new Set<string>();
  for (const step of capabilitySteps(component.deploy)) {
    const { kind: _kind, ...rest } = step;
    for (const r of movedWiringReferences(rest, read, now)) if (!(r.publish && inChange.has(r.source))) refs.add(r.ref);
  }
  if (refs.size === 0) return undefined;
  return `its plan read ${[...refs].sort().join(", ")} before ${refs.size === 1 ? "that output" : "those outputs"} applied as another value`;
}

/**
 * A ledger that reads the real one and records nothing. The plan stage
 * decides the gate only to say where the approval stands; it runs the pull
 * request's own code and holds no write access to `chant/lifecycle`.
 */
export function readOnlyLedger(port: GateLedgerPort): GateLedgerPort {
  return {
    read: (op) => port.read(op),
    ...(port.approvalRule ? { approvalRule: (gate: string, at?: { base?: string }) => port.approvalRule!(gate, at) } : {}),
    async appendPending(input) {
      return { record: { version: 1, kind: "pending", ...input }, pushed: false, pushWarning: "not recorded: the plan stage writes nothing" };
    },
  };
}

/** Where the approval stands, as the report says it. */
export function approvalOf(check: GateCheck): PrApproval {
  if (check.satisfied) {
    const by = check.approvals?.length ? check.approvals.map((r) => r.resolvedBy) : [check.resolution.resolvedBy];
    return { status: "approved", approvedBy: [...new Set(by)] };
  }
  if (check.mismatch) return { status: "changed", ...(check.mismatch.approved ? { approved: check.mismatch.approved } : {}) };
  return { status: "pending" };
}

/** Decide the pull request's gate against `digest`. */
export async function decidePrGate(
  port: GateLedgerPort,
  input: { op: string; gate: string; digest: string; description?: string; now?: string },
): Promise<GateCheck> {
  return evaluateGate(port, {
    op: input.op,
    gate: input.gate,
    planDigest: input.digest,
    ...(input.description ? { description: input.description } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * Who approved the gate but has no standing approving review on the pull
 * request. Each approval's `resolvedBy` is compared with the forge's own
 * naming of each approver (#3163's form).
 */
export function approversWithoutReview(approvedBy: readonly string[], reviewers: readonly string[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const allowed = new Set(reviewers.map(norm));
  return approvedBy.filter((by) => !allowed.has(norm(by)));
}

/**
 * Who approved the gate but wrote the change (#4000): each approval's
 * `resolvedBy` that names one of `authors`, the forge's naming of the pull
 * request's author and of its commits' authors and committers. Their own
 * approval never counts, whether a forge review or a ledger line backs it.
 */
export function approversWhoAuthored(approvedBy: readonly string[], authors: readonly string[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const wrote = new Set(authors.map(norm));
  return approvedBy.filter((by) => wrote.has(norm(by)));
}

export interface PrApplyOptions {
  components: DriverComponent[];
  plan: FanOutPlan;
  registry: CapabilityRegistry;
  env: string;
  vars?: Record<string, unknown>;
  /** The set {@link planPrSet} planned and the gate approved, or {@link resumePrSet}'s set. */
  set: PrPlanSet;
  onProgress?: (event: RunProgressEvent) => void;
  /** Where the apply's events go (#4041): the fan-out's run events. */
  onRunEvent?: RunEventSink;
  /**
   * What an earlier attempt at this approved set applied (#3464): its
   * components, which are reported applied and not run again, and the
   * outputs they left.
   */
  resumed?: { completed: string[]; outputs: Record<string, Record<string, unknown>> };
  /** Called as each component settles, so an attempt record survives a kill (`runFanOut`). */
  onComponentSettled?: (result: DriverComponentResult, outputs: Record<string, unknown> | undefined) => void;
  /** The pull request's gate, which names each later round's gate ({@link prRoundGate}). Default `pr-apply`. */
  gate?: string;
  /**
   * Decide the gate over the plans of a round after the first (#3999): the
   * members held back because an upstream they read applied as another value
   * than their plan read, planned again against the outputs the apply left.
   * The gate is {@link prRoundGate}. Without it, held members are left
   * `waiting` and nothing is planned again.
   */
  decideRound?: (round: { round: number; gate: string; set: PrPlanSet; plan: FanOutPlan }) => Promise<PrRoundDecision>;
}

/** How a round's gate was decided: whether it applies, and where its approval stands. */
export interface PrRoundDecision {
  satisfied: boolean;
  approval: PrApproval;
  /** Why it does not apply, when an approval stands but does not count (`--require-review`). */
  message?: string;
}

export interface PrApplyResult {
  members: PrMember[];
  /** `waiting`: some members wait on an approval of the plan a later round made. */
  status: "applied" | "failed" | "waiting";
  /** Every round's runs together: their results, components and outputs. */
  run: FanOutRunResult;
  /** Each round after the first, in order. Absent when nothing was held back. */
  rounds?: PrRound[];
}

/** Two runs of one apply as one: `b` ran after `a`, against the outputs `a` left. */
function joinRuns(a: FanOutRunResult, b: FanOutRunResult): FanOutRunResult {
  const status: FanOutRunResult["status"] = a.status === "fail" || b.status === "fail" ? "fail" : a.status === "gated" || b.status === "gated" ? "gated" : "ok";
  const gate = a.gate ?? b.gate;
  return {
    plan: a.plan,
    status,
    results: [...a.results, ...b.results],
    completed: [...new Set([...a.completed, ...b.completed])].sort(),
    failed: [...new Set([...a.failed, ...b.failed])].sort(),
    blocked: [...a.blocked, ...b.blocked],
    componentOutputs: b.componentOutputs,
    ...(gate ? { gate } : {}),
    ...(b.held ? { held: b.held } : {}),
  };
}

/**
 * Apply the approved plans in dependency order. A failed component blocks
 * its dependents and nothing else (`runFanOut`). A member whose plan read an
 * upstream output that is not the value standing when its turn comes is held
 * back with what is downstream of it, planned again once the rest settled,
 * and applied when `decideRound` approves that plan (#3999).
 */
export async function applyPrSet(options: PrApplyOptions): Promise<PrApplyResult> {
  const byName = new Map(options.components.map((c) => [c.name, c]));
  const priorCompleted = new Set(options.resumed?.completed ?? []);
  const inChange = new Set([...options.set.members.map((m) => m.component), ...options.plan.order]);
  const toApply = new Set([...inChange].filter((name) => !priorCompleted.has(name)));
  // The outputs standing as the apply starts: what the plans read of
  // components outside the change, and what an earlier attempt's components
  // left (the values the plans read, where its record kept none). A planned
  // value of a component still to apply stands nowhere until it applies.
  const standing: Record<string, Record<string, unknown>> = {
    ...Object.fromEntries(Object.entries(options.set.outputs).filter(([name]) => !toApply.has(name))),
    ...(options.resumed?.outputs ?? {}),
  };
  const runRound = (plan: FanOutPlan, plans: Record<string, Record<string, unknown>>, read: Record<string, Record<string, unknown>>, outputs: Record<string, Record<string, unknown>>) =>
    runFanOut(plan, options.components, options.registry, {
      env: options.env,
      ...(options.vars ? { vars: options.vars } : {}),
      plans,
      componentOutputs: outputs,
      hold: (name, now) => heldReason(byName.get(name)!, read, now, inChange),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
      ...(options.onComponentSettled ? { onComponentSettled: options.onComponentSettled } : {}),
    });

  let run = await runRound(options.plan, options.set.plans, options.set.outputs, { ...standing });
  const rounds: PrRound[] = [];
  /** Per component, the round that applied it or holds it, and that round's set, after the first. */
  const roundOf = new Map<string, { round: number; set: PrPlanSet }>();
  let stopped: "waiting" | "plan-failed" | undefined;
  while (run.held && run.held.length > 0 && run.status === "ok" && options.decideRound) {
    const round = rounds.length + 2;
    const gate = prRoundGate(options.gate ?? PR_APPLY_GATE, round);
    const heldNames = new Set(run.held.map((h) => h.component));
    const plan = remainingFanOut(options.plan, options.components, { completed: options.plan.order.filter((name) => !heldNames.has(name)) });
    const set = await planPrSet({
      components: options.components,
      plan,
      registry: options.registry,
      env: options.env,
      ...(options.vars ? { vars: options.vars } : {}),
      seededOutputs: run.componentOutputs,
    });
    for (const name of plan.order) roundOf.set(name, { round, set });
    const record = (status: PrRound["status"], approval: PrApproval, message?: string): void => {
      rounds.push({ round, gate, digest: set.doc.digest, components: plan.order, approval, status, ...(message ? { message } : {}), changeSet: set.doc });
    };
    if (set.failed) {
      record("plan-failed", { status: "pending" });
      stopped = "plan-failed";
      break;
    }
    const decision = await options.decideRound({ round, gate, set, plan });
    if (!decision.satisfied) {
      record("waiting", decision.approval, decision.message);
      stopped = "waiting";
      break;
    }
    const next = await runRound(plan, set.plans, set.outputs, run.componentOutputs);
    record(next.status === "fail" ? "failed" : "applied", decision.approval);
    run = joinRuns(run, next);
  }

  const completed = new Set(run.completed);
  const held = new Map((run.held ?? []).map((h) => [h.component, h]));
  const blocked = new Map(run.blocked.map((b) => [b.component, b.blockedBy]));
  const errorOf = (component: string): string | undefined => {
    const result = [...run.results].reverse().find((r) => r.component === component);
    if (result?.status === "gated") return `stopped at its own gate ${result.gate?.gate ?? ""}`.trim();
    return result?.records.find((r) => r.status === "fail")?.error;
  };
  const members = options.set.members.map((m): PrMember => {
    if (priorCompleted.has(m.component)) return { ...m, status: "applied" };
    const later = roundOf.get(m.component);
    const fresh = later?.set.members.find((x) => x.member === m.member);
    const asPlanned: PrMember = later && fresh ? { ...m, planDigest: fresh.planDigest, counts: fresh.counts, round: later.round } : m;
    if (completed.has(m.component)) return { ...asPlanned, status: "applied" };
    const h = held.get(m.component);
    if (h) return { ...asPlanned, status: "waiting", held: h.heldBy ? `${h.heldBy} is held: ${h.reason}` : h.reason };
    if (fresh?.status === "plan-failed") return { ...asPlanned, status: "plan-failed", ...(fresh.error ? { error: fresh.error } : {}) };
    if (blocked.has(m.component)) {
      const by = blocked.get(m.component);
      return { ...asPlanned, status: "blocked", ...(by ? { blockedBy: by } : {}) };
    }
    const error = errorOf(m.component);
    return { ...asPlanned, status: "failed", ...(error ? { error } : {}) };
  });
  const status: PrApplyResult["status"] =
    run.status !== "ok" || stopped === "plan-failed" ? "failed" : held.size > 0 || stopped === "waiting" ? "waiting" : "applied";
  return { members, status, run, ...(rounds.length > 0 ? { rounds } : {}) };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const entryKey = (e: Pick<ChangeSetEntry, "member" | "address" | "deposed">): string => `${e.member}\u0000${e.address}\u0000${e.deposed ?? ""}`;

/**
 * Why `member`'s fresh plan is not covered by the approved change set, or
 * `undefined` when it is. A member left over from a partial apply is covered
 * when it plans to the digest that was approved, or when every change it
 * plans now is one the approved plan made:
 *
 * - an entry at the same address with the same action, or a `create` or a
 *   `delete` where a `replace` was approved (the other half applied);
 * - each attribute it writes was written by the approved entry, to the same
 *   value or to one the approved plan knew only after apply. A sensitive
 *   attribute carries no value to compare, so it is covered only where the
 *   approved entry wrote that attribute as sensitive too. On a `create` left
 *   from a `replace`, an attribute the replace did not change is not compared;
 * - each side effect is one the approved plan ran.
 *
 * A member with holes the approved plan did not have is never covered by its
 * entries, since its entries may not say everything it will do.
 */
export function planCoveredBy(approved: ChangeSetDocument, fresh: ChangeSetDocument, member: string): string | undefined {
  const was = approved.members.find((m) => m.member === member);
  const now = fresh.members.find((m) => m.member === member);
  if (!now) return undefined;
  if (!was) return `${member} was not in the approved plan`;
  if (now.status === "failed" || now.planDigest === null) return `${member} failed to plan${now.error ? `: ${now.error}` : ""}`;
  if (was.planDigest !== null && now.planDigest === was.planDigest) return undefined;
  if (was.status === "failed") return `${member} had no approved plan`;
  const knownHoles = new Set(was.holes.map((h) => h.address));
  const newHole = now.holes.find((h) => !knownHoles.has(h.address));
  if (newHole) return `${member} cannot read ${newHole.address} (${newHole.reason}), so its plan cannot be checked against the approved one`;

  const approvedEntries = new Map(approved.entries.filter((e) => e.member === member).map((e) => [entryKey(e), e]));
  for (const e of fresh.entries) {
    if (e.member !== member || e.action === "no-op" || e.action === "read") continue;
    // A create-before-destroy replace whose create applied leaves the old
    // object deposed, and the plan now deletes it under a deposed key.
    const a =
      approvedEntries.get(entryKey(e)) ??
      (e.action === "delete" && e.deposed ? approvedEntries.get(entryKey({ ...e, deposed: undefined })) : undefined);
    if (!a) return `${member} now plans to ${e.action} ${e.address}, which the approved plan did not`;
    const halfReplace = a.action === "replace" && (e.action === "create" || e.action === "delete");
    if (a.action !== e.action && !halfReplace) {
      return `${member} now plans to ${e.action} ${e.address}, where the approved plan would ${a.action} it`;
    }
    const approvedAttrs = new Map(a.attributes.map((attr) => [attr.path, attr]));
    for (const attr of e.attributes) {
      const at = `${e.address}.${attr.path}`;
      const prior = approvedAttrs.get(attr.path);
      if (!prior) {
        if (halfReplace && e.action === "create") continue;
        return `${member} now writes ${at}, which the approved plan did not`;
      }
      if (attr.sensitive) {
        if (!prior.sensitive) return `${member} now writes ${at} as sensitive, so it cannot be compared with the approved value`;
        continue;
      }
      if (prior.sensitive) return `${member} writes ${at}, which the approved plan wrote as sensitive, so it cannot be compared`;
      if (prior.unknown) continue;
      if (attr.unknown) return `${member} now writes ${at} with a value known only after apply, where the approved plan knew it`;
      if (!sameJson(attr.after, prior.after)) return `${member} now writes ${at} to a different value than the approved plan`;
    }
  }
  const approvedEffects = new Set(
    (approved.sideEffects ?? []).filter((s) => s.member === member).map((s) => JSON.stringify([s.address, s.type, s.trigger ?? null, s.event ?? null])),
  );
  for (const s of fresh.sideEffects ?? []) {
    if (s.member !== member) continue;
    if (!approvedEffects.has(JSON.stringify([s.address, s.type, s.trigger ?? null, s.event ?? null]))) {
      return `${member} now runs ${s.address}, which the approved plan did not`;
    }
  }
  return undefined;
}

export interface PrResumeOptions {
  components: DriverComponent[];
  /** The fan-out the change derives now. The caller has checked it is the one the record was made from. */
  plan: FanOutPlan;
  registry: CapabilityRegistry;
  env: string;
  vars?: Record<string, unknown>;
  seededOutputs?: Record<string, Record<string, unknown>>;
  /** The approved set, from the attempt record. */
  record: PrApplyRecord;
  /** Components an earlier attempt applied. */
  completed: string[];
}

export type PrResume =
  | {
      ok: true;
      /** The derivation narrowed to what is left. */
      plan: FanOutPlan;
      /** The approved set, carrying fresh plans for the members left. Its digest is the approved one. */
      set: PrPlanSet;
      /** What the fresh plans of the members left came to. */
      fresh: PrPlanSet;
    }
  | {
      ok: false;
      /** Why the approved set does not cover what is left, one line per member. */
      reasons: string[];
      fresh?: PrPlanSet;
    };

/**
 * Plan what an apply that failed partway left (#3464): narrow the plan by
 * the components that applied, plan the rest against the outputs the
 * approved plans read, and check each member against the approved change
 * set ({@link planCoveredBy}). Covered, the result is the approved set with
 * the new plans in it, to decide the gate against `record.digest` and hand
 * to {@link applyPrSet}. Not covered, it says why, and the caller plans
 * everything and asks for a fresh approval.
 *
 * The record now travels between CI jobs through a cache (#3543), so its
 * change set has to be the one its digest names: the document's own digest
 * is `record.digest`, and the document gives that digest. The digest binds
 * the entries, holes and side effects {@link planCoveredBy} reads (#3555),
 * so a record cannot widen what a re-planned member may do.
 */
export async function resumePrSet(options: PrResumeOptions): Promise<PrResume> {
  const { record } = options;
  if (record.changeSet.digest !== record.digest || !verifyChangeSetDigest(record.changeSet)) {
    return { ok: false, reasons: [`the record's change set is not the one its digest ${record.digest} names`] };
  }
  const plan = remainingFanOut(options.plan, options.components, { completed: options.completed });
  const fresh = await planPrSet({
    components: options.components,
    plan,
    registry: options.registry,
    env: options.env,
    ...(options.vars ? { vars: options.vars } : {}),
    seededOutputs: { ...(options.seededOutputs ?? {}), ...options.record.planOutputs },
  });
  const reasons = fresh.doc.members
    .map((m) => planCoveredBy(options.record.changeSet, fresh.doc, m.member))
    .filter((r): r is string => r !== undefined);
  if (reasons.length > 0) return { ok: false, reasons, fresh };
  return {
    ok: true,
    plan,
    fresh,
    set: {
      doc: options.record.changeSet,
      members: options.record.members.map((m) => ({ ...m, status: "planned" as const })),
      plans: fresh.plans,
      outputs: options.record.planOutputs,
      failed: false,
    },
  };
}

/**
 * The fan-out narrowed to wave `wave` of `plan` (1-based), less the
 * components in `completed` (#4003). Its one wave is what is left of that
 * wave; a dependency outside it, an earlier wave's component among them, is
 * a seed. The digest is the derivation's, as {@link remainingFanOut} keeps it.
 */
export function prWavePlan(plan: FanOutPlan, components: DriverComponent[], wave: number, completed: readonly string[] = []): FanOutPlan {
  const done = new Set(completed);
  const order = (plan.waves[wave - 1] ?? []).filter((name) => !done.has(name));
  const inWave = new Set(order);
  const byName = new Map(components.map((c) => [c.name, c]));
  const seeds = [
    ...new Set([...plan.seeds, ...order.flatMap((name) => (byName.get(name)?.dependsOn ?? []).filter((dep) => !inWave.has(dep)))]),
  ].sort();
  return { order, waves: order.length > 0 ? [order] : [], skipped: [], seeds, indeterminate: plan.indeterminate, digest: plan.digest };
}

/**
 * Why the approved change set does not cover a wave's new plan, one line per
 * member, or `[]` when it covers every member (#4003). A member is covered
 * as {@link planCoveredBy} says, with one rule more: a member whose planner
 * describes no changes (chant's own empty part, for a capability that
 * returns no change set) is covered only by the digest it was approved
 * with, since with no entries there is nothing to compare a moved plan by.
 */
export function waveNotCovered(approved: ChangeSetDocument, fresh: ChangeSetDocument, approvedMembers: readonly PrMember[] = []): string[] {
  // #3999: a member whose approved plan waited only on an artifact a build in
  // the change publishes is covered by that build's provenance, as it is
  // without --wave-gate.
  const byBuild = new Set(approvedMembers.filter((m) => m.buildInputs?.length && !m.unknownInputs?.length).map((m) => m.member));
  return fresh.members
    .map((m) => {
      if (byBuild.has(m.member)) return undefined;
      const was = approved.members.find((a) => a.member === m.member);
      const opaque = m.planner === "chant" && m.lexicon === "chant" && m.status === "planned";
      if (opaque && was && was.planDigest !== m.planDigest) {
        return `${m.member} now plans to ${m.planDigest}, not the approved ${was.planDigest ?? "(none)"}, and its planner describes no changes to compare`;
      }
      return planCoveredBy(approved, fresh, m.member);
    })
    .filter((r): r is string => r !== undefined);
}

export interface PrReportInput {
  stage: "plan" | "apply" | "record";
  pr: number | null;
  env: string;
  /** The workspace member whose pipeline runs the stage (#3465). */
  member?: string;
  base: string;
  head: string;
  op: string;
  gate: string;
  plan: FanOutPlan;
  signal: ComponentChangeSignal;
  set: PrPlanSet;
  approval: PrApproval;
  status: PrStatus;
  members?: PrMember[];
  refusal?: PrRefusal;
  message?: string;
  /** Components an earlier attempt at the approved set applied (#3464). */
  resumed?: string[];
  /** `--wave-gate` (#4003): the wave gate's base name, and each wave reached so far. */
  waveGate?: string;
  waves?: PrWave[];
  /** The rounds the apply planned after an upstream applied (#3999). */
  rounds?: PrRound[];
}

/** The report a stage writes. */
export function prReport(input: PrReportInput): PrReport {
  const changed = new Set(input.signal.changed);
  return {
    $schema: PR_REPORT_SCHEMA_ID,
    contract: PR_REPORT_CONTRACT,
    stage: input.stage,
    pr: input.pr,
    env: input.env,
    ...(input.member ? { member: input.member } : {}),
    base: input.base,
    head: input.head,
    op: input.op,
    gate: input.gate,
    digest: input.set.doc.digest,
    status: input.status,
    ...(input.refusal ? { refusal: input.refusal } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.resumed ? { resumed: { applied: [...input.resumed].sort() } } : {}),
    ...(input.set.deployedOutputs ? { deployedOutputs: input.set.deployedOutputs } : {}),
    ...(input.set.plannedOutputs ? { plannedOutputs: input.set.plannedOutputs } : {}),
    ...(input.rounds && input.rounds.length > 0 ? { rounds: input.rounds } : {}),
    approval: input.approval,
    ...(input.waveGate ? { waveGate: input.waveGate } : {}),
    ...(input.waveGate && input.waves?.length ? { waves: [...input.waves].sort((a, b) => a.wave - b.wave) } : {}),
    selection: {
      changed: input.plan.order.filter((c) => changed.has(c)),
      dependents: input.plan.order.filter((c) => !changed.has(c)),
      unclaimed: input.signal.unclaimed,
      indeterminate: input.plan.indeterminate,
      waves: input.plan.waves,
    },
    members: input.members ?? input.set.members,
    changeSet: input.set.doc,
  };
}
