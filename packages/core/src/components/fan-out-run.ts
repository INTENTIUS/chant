/**
 * Run a derived fan-out (#2417).
 *
 * `./fan-out.ts` decides who runs and in what order; this dispatches it. The
 * two are separate because the deciding is worth testing without a cloud, and
 * because the same plan is what one approval is bound to.
 *
 * ## Why not `runInterpretDriver`
 *
 * That runner stops the whole run at the first failed component, which is the
 * right default for `chant run --components all`: there, the user asked for
 * everything, and a failure means the estate is in a state nobody described.
 *
 * A fan-out is the case where that default throws away the point. The order was
 * derived from the source, so a branch sharing no edge with the failure is
 * *known* to be independent rather than assumed to be. Stopping it buys nothing
 * and costs a second approval to finish. So this runner skips the failed
 * component's subtree and lets the rest of the wave plan proceed.
 *
 * Neither runner's behaviour changes the other's: `runInterpretDriver` is
 * untouched.
 *
 * ## One approval, not one per component
 *
 * The gate is evaluated once, before the first wave, bound to the plan's digest
 * through the same `planDigest` mechanism #2300 gave gates. Twenty components
 * behind one fan-out is one approval, and re-deriving the same fan-out does not
 * expire it. A component's *own* authored gates still decide per component —
 * this adds a gate over the set, it does not remove the ones inside it.
 *
 * ## Or one approval per wave
 *
 * `waveGate` (#3049) is the other mode. Each wave is planned once the waves
 * before it applied, and its gate binds that wave's set digest. The loop,
 * gate names, the digest and the gate decision come from the wave engine
 * (`../wave-engine.ts`, #3766), which `chant run wave` uses too; this module
 * hands it the steps a fan-out plans, decides and applies a wave with. See
 * {@link runGatedWaves}.
 */

import {
  deployContext,
  runComponentDeploy,
  type DriverComponent,
  type DriverComponentResult,
  type GateContext,
} from "./driver";
import type { ReleaseIdentity } from "../telemetry-attribution";
import { downstreamWithin, remainingFanOut, type FanOutGroup, type FanOutPlan, type FanOutProgress, type FanOutSkip } from "./fan-out";
import { evaluateGate, gitGateLedgerPort, type GateCheck, type GateLedgerPort } from "../op/gate";
import type { RunProgressEvent } from "./run-progress";
import { emitGateStep, joinRunEventSinks, progressSinkOf, type RunEventSink } from "../run-event-stream";
import type { CapabilityRegistry, GroupMemberStatus, GroupRun } from "./capability";
import type { PendingGateRecord } from "../lifecycle/gate-ledger";
import type { DeployContext } from "./capability";
import { groupsByComponent, narrowGroups, planAndRunComponentGroup, runComponentGroup } from "./groups";
import { planWaveComponent, type WaveComponentPlan } from "./wave-plan";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { leaseRowsOf, type LockGrain, type LockRow } from "../lifecycle/lock-rows";
import { isLockRowsHeldError, type RowLease, type RowLeasePort } from "./row-lease";
import { decideWaveGate, runWaveLoop, waveGateName, waveSetDigest, type WaveMember, type WaveRecord } from "../wave-engine";

/** The sink a fan-out emits to: run events, and the older stream through them. */
function fanOutSink(options: FanOutRunOptions): RunEventSink | undefined {
  return joinRunEventSinks(options.onRunEvent, progressSinkOf(options.onProgress));
}

/** The 1-based wave of each component in `waves`. */
function waveNumbers(waves: string[][]): Map<string, number> {
  const out = new Map<string, number>();
  waves.forEach((wave, i) => wave.forEach((name) => out.set(name, i + 1)));
  return out;
}

/**
 * The settles of components a fan-out does not start (#4007): `blocked`
 * when a dependency failed or stopped at a gate, `already-applied` when an
 * earlier attempt applied it. Each is said once, with no `component-start`
 * before it, so a reader of the stream sees every component of the plan.
 */
function skipSettles(emit: RunEventSink | undefined, waveOf: Map<string, number>) {
  const said = new Set<string>();
  const say = (component: string, wave: number | undefined, body: { status: "blocked"; blockedBy: string } | { status: "already-applied" }): void => {
    if (!emit || wave === undefined || said.has(component)) return;
    said.add(component);
    emit({ type: "component-settle", wave, component, ...body });
  };
  return {
    /** Each component in `blockedBy` not yet said, in wave order then by name. */
    blocked(blockedBy: Map<string, string>): void {
      const order = [...blockedBy.keys()].sort((a, b) => (waveOf.get(a) ?? 0) - (waveOf.get(b) ?? 0) || a.localeCompare(b));
      for (const component of order) say(component, waveOf.get(component), { status: "blocked", blockedBy: blockedBy.get(component)! });
    },
    /**
     * What an earlier attempt left (`remainingFanOut`'s skips): the components
     * it applied, and the ones its failures blocked. Their wave is the one
     * they have in the derivation, `derived`, which a resumed run re-layers.
     */
    carried(skipped: FanOutSkip[], derived: Map<string, number>): void {
      for (const skip of skipped) {
        if (skip.reason === "already-applied") say(skip.component, derived.get(skip.component), { status: "already-applied" });
        else if (skip.reason === "blocked" && skip.blockedBy) say(skip.component, derived.get(skip.component), { status: "blocked", blockedBy: skip.blockedBy });
      }
    },
  };
}

/**
 * One gate per wave (#3049), each bound to its wave's set digest. The other
 * mode beside {@link FanOutGate}: that one approves the whole set once, this
 * one approves each wave after the waves before it applied.
 */
export interface FanOutWaveGate {
  /** The op the gates are recorded under, `fan-out` from the CLI. */
  op: string;
  /** The base gate name. Wave `n` waits on `waveGateName(gate, n)`. */
  gate: string;
  description?: string;
  timeout?: string;
  /**
   * Plan one wave's components. Called once per wave, after every earlier
   * wave settled, with the outputs they left. Defaults to
   * `planWaveComponent` over the run's registry.
   */
  planComponent?: (
    component: DriverComponent,
    ctx: DeployContext,
    componentOutputs: Record<string, Record<string, unknown>>,
  ) => Promise<WaveComponentPlan>;
  /**
   * Run this wave and no other: CI's one job per wave. An earlier wave with
   * work left refuses the run, since this wave's plan would read outputs that
   * do not exist yet. A later wave is left for its own job.
   */
  only?: number;
  /**
   * With `only` (#4291): members of earlier waves the record says failed to
   * plan or to apply. Each blocks its dependents in this wave and names
   * itself as what blocked them; the rest of the wave runs. An earlier
   * member that neither applied nor failed still refuses the run.
   */
  failedEarlier?: readonly string[];
  /**
   * With `only` (#4291): earlier waves the record says stopped at their gate.
   * A member left in one of them stops this wave too ({@link EarlierWaveWaitingError}),
   * since a gate nobody approved stops every wave after it.
   */
  waitingEarlier?: ReadonlyArray<{ wave: number; gate: string; components: readonly string[] }>;
}

/** Thrown when `FanOutWaveGate.only` names a wave whose predecessors have not all applied. */
export class EarlierWaveNotAppliedError extends Error {
  constructor(
    readonly wave: number,
    readonly earlier: number,
    readonly components: string[],
  ) {
    super(
      `wave ${wave} cannot run yet: wave ${earlier} has not applied (${components.join(", ")}). ` +
        `Run wave ${earlier} first, with the same --resume record.`,
    );
    this.name = "EarlierWaveNotAppliedError";
  }
}

/**
 * Thrown when `FanOutWaveGate.only` names a wave after one that waits at its
 * gate (#4291): nothing in this wave runs until that gate is approved and
 * its job runs again. The CLI exits 3, as the waiting wave's job does.
 */
export class EarlierWaveWaitingError extends Error {
  constructor(
    readonly wave: number,
    readonly earlier: number,
    readonly gate: string,
  ) {
    super(`wave ${wave} does not run yet: wave ${earlier} waits at its gate ${gate}. Approve it and run wave ${earlier} again, then this wave.`);
    this.name = "EarlierWaveWaitingError";
  }
}

/** The single gate over a whole fan-out. Omit it to run without one. */
export interface FanOutGate {
  /** The name `chant approve <op> <gate>` takes — the fan-out's name, not a component's. */
  op: string;
  gate: string;
  description?: string;
  timeout?: string;
}

export interface FanOutRunOptions {
  env: string;
  vars?: Record<string, unknown>;
  /** The addresses each component narrows to (#4300), by component: its steps' `DeployContext.targets`. */
  targets?: Readonly<Record<string, readonly string[]>>;
  /** `ci.lockGrain` as declared (#4594), for every step's `DeployContext.lockGrain`. Absent: each step takes its lexicon's default. */
  lockGrain?: LockGrain;
  /**
   * The run's row lease (#4594). Each step on the resource grain leases its
   * rows through it, a group leases its members' rows in one take, and under
   * `waveGate` each wave leases the rows its plans lock before it applies.
   * Not with `plans`: a caller that planned beforehand leases those rows
   * itself, as pr-apply does. Absent: no lease.
   */
  rowLease?: RowLeasePort;
  /** Outputs of components this run is not running: the ones the plan lists in `seeds`. */
  componentOutputs?: Record<string, Record<string, unknown>>;
  onProgress?: (event: RunProgressEvent) => void;
  /**
   * Where the run's events go (#4041, `--events-json`). A gate over the set
   * or over a wave is a `gate:<name>` step of a `gate` phase with no
   * component, settled before the components it lets through start.
   */
  onRunEvent?: RunEventSink;
  gates?: GateLedgerPort;
  now?: string;
  /** One approval over the ordered set, bound to `plan.digest`. */
  gate?: FanOutGate;
  /** One approval per wave, each bound to its wave's set digest (#3049). Not with `gate`. */
  waveGate?: FanOutWaveGate;
  /**
   * Plans made before the run, per component and then per member, handed to
   * each component's steps as `DeployContext.plans` (#3183). A pull request's
   * apply plans every member, decides its gate against the set, and passes
   * the plans here so each step applies the plan that was approved. Not
   * with `waveGate`, which plans each wave itself.
   */
  plans?: Record<string, Record<string, unknown>>;
  /** Called as each wave settles or stops at its gate, so a record survives a kill. */
  onWaveSettled?: (record: WaveRecord) => void;
  /** What an earlier attempt at this same plan already did. */
  progress?: FanOutProgress;
  /**
   * What steps kept per member in an earlier attempt (#3459), handed to every
   * step as `DeployContext.carried`. Read from the attempt record.
   */
  carried?: Record<string, unknown>;
  /**
   * Called when a step keeps a value for its member (`DeployContext.carry`),
   * so the caller can write it into the attempt record at once. Without it,
   * steps get no `carry`.
   */
  onCarry?: (member: string, value: unknown) => void;
  /** The release each component deploys (#3061), as `InterpretRunOptions.releaseIdentity`. */
  releaseIdentity?: (component: string) => ReleaseIdentity | undefined;
  /**
   * Called as each component settles, with the outputs it exposed, before the
   * rest of its wave finishes. A caller that records progress here keeps what
   * already applied when the process is killed mid-fan-out, which waiting for
   * the returned result cannot do.
   */
  onComponentSettled?: (result: DriverComponentResult, outputs: Record<string, unknown> | undefined) => void;
  /**
   * Asked as each component's wave starts, with the outputs standing then
   * (#3999). A reason holds the component back: it does not run, and nothing
   * downstream of it runs either; each is listed in `held` and settles
   * `waiting`. A pull request's apply holds a member whose plan read an
   * upstream output that applied as another value, or that was known only
   * after apply. Not with `waveGate`, which plans each wave after the one
   * before it applied.
   */
  hold?: (component: string, componentOutputs: Record<string, Record<string, unknown>>) => string | undefined;
  /**
   * The approved plan of each group in `plan.groups` (ws-107), by the
   * group's first component. A group runs through `runGroup` in its wave,
   * in place of its members' own runs, and is held and blocked as one: a
   * member held or blocked holds or blocks the rest. Not with `waveGate`.
   */
  groupRuns?: Record<string, GroupRun>;
  /**
   * A group with no entry in `groupRuns` plans in its wave against the
   * outputs standing, then applies (#4465): `components fan-out` plans
   * nothing before it runs. Without it such a group fails, which is what a
   * pull request's apply wants for a group nobody approved.
   */
  planGroupsAtWave?: boolean;
}

/** A component {@link FanOutRunOptions.hold} held back, or one downstream of it. */
export interface FanOutHeld {
  component: string;
  /** Why the hook held it, or, downstream, why it held the component named in `heldBy`. */
  reason: string;
  /** Downstream of a held component: that component. */
  heldBy?: string;
}

export interface FanOutRunResult {
  /** The plan actually dispatched — `plan` narrowed by `options.progress`. */
  plan: FanOutPlan;
  status: "ok" | "fail" | "gated";
  results: DriverComponentResult[];
  /** Reached `ok` this attempt. Feed back as `progress.completed` to resume. */
  completed: string[];
  /** Failed this attempt. Feed back as `progress.failed`. */
  failed: string[];
  /** Never dispatched because something upstream failed, each naming the failure. */
  blocked: FanOutSkip[];
  componentOutputs: Record<string, Record<string, unknown>>;
  /** Present when `status === "gated"`: the pending fact to approve. */
  gate?: PendingGateRecord;
  /** With `waveGate`: each wave this attempt planned, in order, the one it stopped at included. */
  waves?: WaveRecord[];
  /** What {@link FanOutRunOptions.hold} held back, in plan order. Absent when nothing was. */
  held?: FanOutHeld[];
  /**
   * Members of a group whose apply stopped before their part began (ws-107),
   * sorted. Each has a `fail` result but is not in `failed`; what depends on
   * it outside the group is blocked by it. Absent when none.
   */
  notStarted?: string[];
  /** How each member of a group that ran ended, as its capability said (#4446), by component. Absent when no group ran. */
  groupOutcomes?: Record<string, GroupMemberStatus>;
}

/**
 * Dispatch a fan-out plan.
 *
 * Resolves rather than throws on a failed component: a fan-out's partial
 * outcome is the interesting one, and the caller needs `completed` to resume.
 */
export async function runFanOut(
  plan: FanOutPlan,
  components: DriverComponent[],
  registry: CapabilityRegistry,
  options: FanOutRunOptions,
): Promise<FanOutRunResult> {
  const byName = new Map(components.map((c) => [c.name, c]));
  const gates: GateContext = {
    port: options.gates ?? gitGateLedgerPort(),
    ...(options.now ? { now: options.now } : {}),
  };
  const componentOutputs: Record<string, Record<string, unknown>> = { ...(options.componentOutputs ?? {}) };

  // Resume first, so the gate is decided against the work that is actually left
  // and a re-run does not re-approve. The digest is carried, not recomputed.
  // A group keeps what is left of it (#4465).
  const active = options.progress ? narrowGroups(remainingFanOut(plan, components, options.progress), components, plan.groups) : plan;

  if (options.gate && options.waveGate) {
    throw new Error("a fan-out takes one gate over the set or one gate per wave, not both");
  }
  if (options.waveGate && options.plans) {
    throw new Error("a gated-wave fan-out plans each wave itself, so it takes no plans made beforehand");
  }
  if (options.rowLease && options.plans) {
    throw new Error("a fan-out handed plans made beforehand leases their rows where they were planned, so it takes no row lease");
  }
  if (options.waveGate && plan.groups?.length) {
    throw new Error("a gated-wave fan-out plans component by component, so it takes no groups");
  }
  if (options.waveGate) {
    return runGatedWaves(plan, active, components, registry, options, options.waveGate, gates, componentOutputs);
  }

  const emit = fanOutSink(options);
  emit?.({ type: "run-start", waves: active.waves });
  const skips = skipSettles(emit, waveNumbers(active.waves));
  skips.carried(active.skipped, waveNumbers(plan.waves));

  if (options.gate) {
    const gate = options.gate;
    const check = await emitGateStep(emit, gate, () =>
      evaluateGate(gates.port, {
        op: gate.op,
        gate: gate.gate,
        planDigest: fanOutGateDigest(active.digest, options.targets),
        ...(gate.description ? { description: gate.description } : {}),
        ...(gate.timeout ? { timeout: gate.timeout } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
    );
    if (!check.satisfied) {
      // Nothing ran, so nothing is half-applied and there is nothing to
      // compensate. A gate is a fact, not a failure.
      emit?.({ type: "run-settle", status: "gated", durationMs: null });
      return {
        plan: active,
        status: "gated",
        results: [],
        completed: [],
        failed: [],
        blocked: [],
        componentOutputs,
        gate: check.pending,
      };
    }
  }

  const results: DriverComponentResult[] = [];
  const completed: string[] = [];
  const failed: string[] = [];
  const notStarted: string[] = [];
  const groupOutcomes: Record<string, GroupMemberStatus> = {};
  const blockedBy = new Map<string, string>();
  const held = new Map<string, FanOutHeld>();
  let gatedFact: PendingGateRecord | undefined;

  const inPlan = new Set(active.order);
  const waveOf = waveNumbers(active.waves);
  // ws-107: a group applies as one unit, so it is held and blocked as one.
  const groupOf = groupsByComponent(active);
  /** Hold `root` and everything downstream of it that has not settled otherwise. With `heldBy`, `root` is held for that component's reason. */
  const markHeld = (root: string, reason: string, heldBy?: string): void => {
    held.set(root, { component: root, reason, ...(heldBy ? { heldBy } : {}) });
    emit?.({ type: "component-settle", wave: waveOf.get(root)!, component: root, status: "waiting" });
    for (const [component] of downstreamWithin(components, inPlan, [root])) {
      if (held.has(component) || blockedBy.has(component) || failed.includes(component)) continue;
      held.set(component, { component, reason, heldBy: heldBy ?? root });
      emit?.({ type: "component-settle", wave: waveOf.get(component)!, component, status: "waiting" });
    }
  };
  /** Skip everything downstream of `roots`, blaming a root rather than the nearest edge. */
  const markBlocked = (...roots: string[]): void => {
    for (const [component, by] of downstreamWithin(components, inPlan, roots)) {
      if (blockedBy.has(component) || failed.includes(component) || completed.includes(component) || notStarted.includes(component)) continue;
      blockedBy.set(component, by);
    }
  };

  for (const [waveIndex, wave] of active.waves.entries()) {
    const waveNum = waveIndex + 1;
    // A member blocked blocks its whole group, by the same failure.
    for (const name of wave) {
      const by = blockedBy.get(name);
      if (by === undefined) continue;
      for (const mate of groupOf.get(name)?.components ?? []) if (!blockedBy.has(mate) && mate !== by) blockedBy.set(mate, by);
    }
    // A component whose upstream failed in an earlier wave is not dispatched.
    const candidates = wave.filter((name) => inPlan.has(name) && !blockedBy.has(name) && !held.has(name));
    for (const name of candidates) {
      if (held.has(name)) continue;
      const reason = options.hold?.(name, componentOutputs);
      if (reason === undefined) continue;
      markHeld(name, reason);
      for (const mate of groupOf.get(name)?.components ?? []) if (!held.has(mate)) markHeld(mate, reason, name);
    }
    const runnable = candidates.filter((name) => !held.has(name));
    if (runnable.length === 0) continue;

    emit?.({ type: "wave-start", wave: waveNum, components: runnable });
    const groupsHere = [...new Set(runnable.map((name) => groupOf.get(name)).filter((g): g is FanOutGroup => g !== undefined))];
    // Groups and the wave's other components run side by side, as a wave's components do.
    const groupRuns = Promise.all(
      groupsHere.map(async (group) => {
        for (const name of group.components) emit?.({ type: "component-start", wave: waveNum, component: name });
        const approved = options.groupRuns?.[group.components[0]!];
        const each = {
          group,
          components: byName,
          registry,
          env: options.env,
          ...(options.vars ? { vars: options.vars } : {}),
          ctxOf: (name: string) => fanOutContext(options, name),
          componentOutputs,
        };
        const ran = approved === undefined && options.planGroupsAtWave ? await planAndRunComponentGroup(each) : await runComponentGroup({ ...each, run: approved });
        for (const result of ran.results) {
          emit?.({ type: "component-settle", wave: waveNum, component: result.component, status: result.status === "fail" ? "failed" : result.status });
          options.onComponentSettled?.(result, componentOutputs[result.component]);
        }
        return ran;
      }),
    );
    const waveResults = await Promise.all(
      runnable.filter((name) => !groupOf.has(name)).map(async (name) => {
        emit?.({ type: "component-start", wave: waveNum, component: name });
        const planned = options.plans?.[name];
        const result = await runComponentDeploy(
          byName.get(name)!,
          { ...fanOutContext(options, name), ...(planned && Object.keys(planned).length > 0 ? { plans: planned } : {}) },
          registry,
          componentOutputs,
          undefined,
          gates,
          emit,
        );
        emit?.({
          type: "component-settle",
          wave: waveNum,
          component: name,
          status: result.status === "fail" ? "failed" : result.status,
        });
        options.onComponentSettled?.(result, componentOutputs[name]);
        return result;
      }),
    );
    const groupResults = await groupRuns;
    results.push(...waveResults);

    for (const result of waveResults) {
      if (result.status === "ok") {
        completed.push(result.component);
        continue;
      }
      if (result.status === "fail") {
        failed.push(result.component);
        markBlocked(result.component);
        continue;
      }
      // A component of its own stopped at one of its authored gates. Its
      // dependents cannot run either, for the same reason a failure's cannot:
      // the value they would read has not landed.
      gatedFact ??= result.gate;
      markBlocked(result.component);
    }
    // A group's members settle together; what depends on a member that failed
    // or never started, outside the group, is blocked by that member.
    for (const ran of groupResults) {
      results.push(...ran.results);
      Object.assign(groupOutcomes, ran.outcomes);
      const stopped: string[] = [];
      for (const result of ran.results) {
        if (result.status === "ok") completed.push(result.component);
        else if (ran.notStarted.includes(result.component)) notStarted.push(result.component);
        else failed.push(result.component);
        if (result.status !== "ok") stopped.push(result.component);
      }
      if (stopped.length > 0) markBlocked(...stopped);
    }

    const waveFailed = waveResults.some((r) => r.status === "fail") || groupResults.some((ran) => ran.results.some((r) => r.status === "fail"));
    emit?.({
      type: "wave-settle",
      wave: waveNum,
      status: waveFailed ? "failed" : waveResults.some((r) => r.status === "gated") ? "gated" : "ok",
    });
    // What this wave's failures and gates hold back settles now, before the next wave starts.
    skips.blocked(blockedBy);
  }

  const blocked: FanOutSkip[] = [...blockedBy.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([component, by]) => ({ component, reason: "blocked" as const, blockedBy: by }));

  // A failure outranks a gate: something is actually broken, and reporting the
  // run as "waiting on a human" would hide it. Same precedence the driver uses.
  const status: FanOutRunResult["status"] = failed.length > 0 || notStarted.length > 0 ? "fail" : gatedFact ? "gated" : "ok";
  emit?.({ type: "run-settle", status: status === "fail" ? "failed" : status, durationMs: null });

  return {
    plan: active,
    status,
    results,
    completed: [...completed].sort(),
    failed: [...failed].sort(),
    blocked,
    componentOutputs,
    ...(gatedFact ? { gate: gatedFact } : {}),
    ...(held.size > 0 ? { held: active.order.filter((name) => held.has(name)).map((name) => held.get(name)!) } : {}),
    ...(notStarted.length > 0 ? { notStarted: [...notStarted].sort() } : {}),
    ...(Object.keys(groupOutcomes).length > 0 ? { groupOutcomes } : {}),
  };
}

/**
 * The digest a gate over the whole set binds: the derivation's digest, and,
 * when the run narrows components to targets (#4300), the digest over it and
 * every component's sorted targets. An approval of the whole set then covers
 * no narrowed run, and one narrowed run's approval covers no other.
 */
export function fanOutGateDigest(digest: string, targets: FanOutRunOptions["targets"]): string {
  const narrowed = Object.entries(targets ?? {})
    .filter(([, t]) => t.length > 0)
    .map(([component, t]) => [component, [...new Set(t)].sort()] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (narrowed.length === 0) return digest;
  return computePlanDigest("fan-out-targets", { plan: digest, targets: Object.fromEntries(narrowed) });
}

/** The run's `deployContext`, with the carried state and the carry callback (#3459) when the caller gave them. */
function fanOutContext(options: FanOutRunOptions, component: string): DeployContext {
  return {
    ...deployContext(options, component),
    ...(options.carried && Object.keys(options.carried).length > 0 ? { carried: options.carried } : {}),
    ...(options.onCarry ? { carry: options.onCarry } : {}),
  };
}

/** A plan failure as a component result, so it reads like any other failed component. */
function planFailure(component: string, error: string): DriverComponentResult {
  return {
    component,
    ok: false,
    status: "fail",
    records: [{ component, phase: "Plan", kind: "plan", status: "fail", durationMs: 0, error }],
  };
}

/**
 * The per-wave mode (#3049). Waves keep the numbers the derivation gave them,
 * so on a resumed attempt wave 3 is still wave 3 and its gate, and the
 * approval recorded for it, are the same ones.
 *
 * For each wave with work left: plan its components against the outputs
 * earlier waves wrote, take the set digest of what was planned, and decide
 * `waveGateName(gate, n)` against it. Approved, the wave runs, each
 * component applying the plans its steps just made. Not approved, the run
 * stops there with nothing in that wave or after it applied. An approval
 * that stands for another digest (the set changed since someone approved
 * it) is the same stop, and the record names both digests.
 *
 * A component that fails to plan or to apply blocks its own dependents and
 * nothing else, as in the whole-set mode.
 */
async function runGatedWaves(
  plan: FanOutPlan,
  active: FanOutPlan,
  components: DriverComponent[],
  registry: CapabilityRegistry,
  options: FanOutRunOptions,
  waveGate: FanOutWaveGate,
  gates: GateContext,
  componentOutputs: Record<string, Record<string, unknown>>,
): Promise<FanOutRunResult> {
  const byName = new Map(components.map((c) => [c.name, c]));
  const left = new Set(active.order);
  const planComponent =
    waveGate.planComponent ??
    ((component: DriverComponent, ctx: DeployContext, outputs: Record<string, Record<string, unknown>>) =>
      planWaveComponent(component, registry, ctx, outputs));

  const results: DriverComponentResult[] = [];
  const completed: string[] = [];
  const failed: string[] = [];
  const blockedBy = new Map<string, string>();
  const waves: WaveRecord[] = [];
  let gatedFact: PendingGateRecord | undefined;

  const markBlocked = (root: string): void => {
    for (const [component, by] of downstreamWithin(components, left, [root])) {
      if (blockedBy.has(component) || failed.includes(component)) continue;
      blockedBy.set(component, by);
    }
  };

  const emit = fanOutSink(options);
  emit?.({ type: "run-start", waves: plan.waves });
  const skips = skipSettles(emit, waveNumbers(plan.waves));
  skips.carried(active.skipped, waveNumbers(plan.waves));

  /** What planning one wave gave. */
  interface Planned {
    runnable: string[];
    gateName: string;
    contexts: Map<string, DeployContext>;
    members: WaveMember[];
    plansFor: Map<string, Record<string, unknown>>;
    /** The rows each component's plan locks on the resource grain (#4594). */
    rowsFor: Map<string, LockRow[]>;
    waveFailures: Array<{ component: string; error?: string }>;
  }
  /** `next`: go on to the next wave. `stop`: the run ends here. */
  type Outcome = "next" | "stop";

  await runWaveLoop<Planned, { check: Extract<GateCheck, { satisfied: true }>; record: WaveRecord; toRun: string[] }, Outcome>({
    first: 1,
    onward: (_k, outcome) => outcome === "next",

    async plan({ k: waveNum }) {
      const wave = plan.waves[waveNum - 1];
      if (!wave) return { end: "stop" };
      const runnable = wave.filter((name) => left.has(name) && !blockedBy.has(name));
      if (waveGate.only !== undefined && waveNum < waveGate.only) {
        // #4291: an earlier member that failed blocks only its dependents; one that waits at its gate stops this wave.
        const failedBefore = new Set(waveGate.failedEarlier ?? []);
        const open = runnable.filter((name) => !failedBefore.has(name));
        const waiting = waveGate.waitingEarlier?.find((w) => w.wave === waveNum && open.some((name) => w.components.includes(name)));
        if (waiting) throw new EarlierWaveWaitingError(waveGate.only, waveNum, waiting.gate);
        if (open.length > 0) throw new EarlierWaveNotAppliedError(waveGate.only, waveNum, open);
        for (const name of runnable) markBlocked(name);
        return { end: "next" };
      }
      if (waveGate.only !== undefined && waveNum > waveGate.only) return { end: "stop" };
      if (runnable.length === 0) return { end: "next" };

      const gateName = waveGateName(waveGate.gate, waveNum);
      const contexts = new Map(runnable.map((name) => [name, fanOutContext(options, name)]));
      const planned = await Promise.all(
        runnable.map((name) => planComponent(byName.get(name)!, contexts.get(name)!, componentOutputs)),
      );

      const members: WaveMember[] = [];
      const plansFor = new Map<string, Record<string, unknown>>();
      const rowsFor = new Map<string, LockRow[]>();
      const waveFailures: Array<{ component: string; error?: string }> = [];
      for (const p of planned) {
        if ("error" in p) {
          waveFailures.push({ component: p.component, error: p.error });
          continue;
        }
        members.push(...p.members);
        plansFor.set(p.component, p.plans);
        rowsFor.set(p.component, leaseRowsOf(p.locks));
      }
      return { go: { runnable, gateName, contexts, members, plansFor, rowsFor, waveFailures } };
    },

    digest(_at, { members, plansFor, waveFailures }) {
      try {
        // A wave where nothing planned has no set, and so no digest.
        return members.length > 0 ? waveSetDigest(members) : "";
      } catch (err) {
        // Two components planning the same root: there is no one plan for it.
        const error = err instanceof Error ? err.message : String(err);
        for (const name of plansFor.keys()) waveFailures.push({ component: name, error });
        plansFor.clear();
        return "";
      }
    },

    async decide({ k: waveNum }, { runnable, gateName, members, plansFor, waveFailures }, digest) {
      for (const f of waveFailures) {
        failed.push(f.component);
        results.push(planFailure(f.component, f.error ?? "plan failed"));
        markBlocked(f.component);
      }
      skips.blocked(blockedBy);

      const toRun = runnable.filter((name) => plansFor.has(name));
      const record: WaveRecord = {
        wave: waveNum,
        op: waveGate.op,
        gate: gateName,
        components: [...runnable].sort(),
        digest,
        members: [...members].sort((a, b) => a.member.localeCompare(b.member)),
        status: "failed",
        ...(waveFailures.length > 0 ? { failed: waveFailures } : {}),
      };
      if (toRun.length === 0) {
        waves.push(record);
        options.onWaveSettled?.(record);
        return { end: "next" };
      }

      const check = await emitGateStep(emit, { op: waveGate.op, gate: gateName }, () =>
        decideWaveGate(gates.port, {
          op: waveGate.op,
          gate: gateName,
          digest,
          description: waveGate.description ?? `wave ${waveNum} of ${plan.waves.length}: ${toRun.join(", ")}`,
          ...(waveGate.timeout ? { timeout: waveGate.timeout } : {}),
          ...(options.now ? { now: options.now } : {}),
        }),
      );
      if (!check.satisfied) {
        // Nothing in this wave ran, and no later wave is planned: its plan
        // would read outputs this wave has not written.
        const stopped: WaveRecord = {
          ...record,
          status: "gated",
          ...(check.mismatch?.approved ? { approved: check.mismatch.approved } : {}),
        };
        waves.push(stopped);
        options.onWaveSettled?.(stopped);
        gatedFact = check.pending;
        return { end: "stop" };
      }
      return { go: { check, record, toRun } };
    },

    async apply({ k: waveNum }, { contexts, plansFor, rowsFor, waveFailures }, { check, record, toRun }) {
      emit?.({ type: "wave-start", wave: waveNum, components: toRun });
      // #4594: the rows of the plans the wave's gate approved, in one take before anything of the wave applies.
      const rows = toRun.flatMap((name) => rowsFor.get(name) ?? []);
      let waveLease: RowLease | undefined;
      if (options.rowLease && rows.length > 0) {
        try {
          waveLease = await options.rowLease.take(rows, `wave ${waveNum}`);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const held = isLockRowsHeldError(err);
          for (const name of toRun) {
            results.push({ component: name, ok: false, status: "fail", records: [{ component: name, phase: "Apply", kind: "lock-rows", status: "fail", durationMs: 0, error, ...(held ? { held: true as const } : {}) }] });
            failed.push(name);
            waveFailures.push({ component: name, error });
            emit?.({ type: "component-settle", wave: waveNum, component: name, status: "failed" });
            markBlocked(name);
          }
          const settled: WaveRecord = { ...record, status: "failed", approvedBy: check.resolution.resolvedBy, failed: waveFailures };
          waves.push(settled);
          options.onWaveSettled?.(settled);
          emit?.({ type: "wave-settle", wave: waveNum, status: "failed" });
          skips.blocked(blockedBy);
          return "next";
        }
      }
      let waveResults: DriverComponentResult[];
      try {
        waveResults = await Promise.all(
          toRun.map(async (name) => {
            emit?.({ type: "component-start", wave: waveNum, component: name });
            const plans = plansFor.get(name)!;
            // The wave holds the rows already, so its steps take no lease of their own.
            const { rowLease: _leased, ...own } = contexts.get(name)!;
            const ctx = { ...own, ...(Object.keys(plans).length > 0 ? { plans } : {}) };
            const result = await runComponentDeploy(byName.get(name)!, ctx, registry, componentOutputs, undefined, gates, emit);
            emit?.({
              type: "component-settle",
              wave: waveNum,
              component: name,
              status: result.status === "fail" ? "failed" : result.status,
            });
            options.onComponentSettled?.(result, componentOutputs[name]);
            return result;
          }),
        );
      } finally {
        await waveLease?.release();
      }
      results.push(...waveResults);

      for (const result of waveResults) {
        if (result.status === "ok") {
          completed.push(result.component);
          continue;
        }
        if (result.status === "fail") {
          failed.push(result.component);
          waveFailures.push({ component: result.component });
        } else {
          gatedFact ??= result.gate;
        }
        markBlocked(result.component);
      }

      const settled: WaveRecord = {
        ...record,
        status: waveFailures.length > 0 ? "failed" : "applied",
        approvedBy: check.resolution.resolvedBy,
        ...(waveFailures.length > 0 ? { failed: waveFailures } : {}),
      };
      waves.push(settled);
      options.onWaveSettled?.(settled);
      emit?.({
        type: "wave-settle",
        wave: waveNum,
        status: waveFailures.length > 0 ? "failed" : waveResults.some((r) => r.status === "gated") ? "gated" : "ok",
      });
      skips.blocked(blockedBy);
      return "next";
    },
  });

  const blocked: FanOutSkip[] = [...blockedBy.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([component, by]) => ({ component, reason: "blocked" as const, blockedBy: by }));

  // #4291: a member of this job's wave that an earlier job's failure blocked fails the job, though the rest of the wave applied.
  const blockedHere = waveGate.only !== undefined && (plan.waves[waveGate.only - 1] ?? []).some((name) => blockedBy.has(name));
  const status: FanOutRunResult["status"] = failed.length > 0 || blockedHere ? "fail" : gatedFact ? "gated" : "ok";
  emit?.({ type: "run-settle", status: status === "fail" ? "failed" : status, durationMs: null });

  return {
    // The derivation's waves, not the narrowed re-layering: their numbers name the gates.
    plan: { ...active, waves: plan.waves },
    status,
    results,
    completed: [...completed].sort(),
    failed: [...failed].sort(),
    blocked,
    componentOutputs,
    ...(gatedFact ? { gate: gatedFact } : {}),
    waves,
  };
}
