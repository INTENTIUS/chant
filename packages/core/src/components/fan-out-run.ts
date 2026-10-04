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
 * before it applied, and its gate binds that wave's set digest
 * (`../gated-waves.ts`). See {@link runGatedWaves}.
 */

import {
  deployContext,
  runComponentDeploy,
  type DriverComponent,
  type DriverComponentResult,
  type GateContext,
} from "./driver";
import type { ReleaseIdentity } from "../telemetry-attribution";
import { downstreamWithin, remainingFanOut, type FanOutPlan, type FanOutProgress, type FanOutSkip } from "./fan-out";
import { evaluateGate, gitGateLedgerPort, type GateLedgerPort } from "../op/gate";
import type { RunProgressEvent } from "./run-progress";
import type { CapabilityRegistry } from "./capability";
import type { PendingGateRecord } from "../lifecycle/gate-ledger";
import type { DeployContext } from "./capability";
import { planWaveComponent, type WaveComponentPlan } from "./wave-plan";
import { waveGateName, waveSetDigest, type WaveMember, type WaveRecord } from "../gated-waves";

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
  /** Outputs of components this run is not running: the ones the plan lists in `seeds`. */
  componentOutputs?: Record<string, Record<string, unknown>>;
  onProgress?: (event: RunProgressEvent) => void;
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
  const active = options.progress ? remainingFanOut(plan, components, options.progress) : plan;

  if (options.gate && options.waveGate) {
    throw new Error("a fan-out takes one gate over the set or one gate per wave, not both");
  }
  if (options.waveGate && options.plans) {
    throw new Error("a gated-wave fan-out plans each wave itself, so it takes no plans made beforehand");
  }
  if (options.waveGate) {
    return runGatedWaves(plan, active, components, registry, options, options.waveGate, gates, componentOutputs);
  }

  if (options.gate) {
    const check = await evaluateGate(gates.port, {
      op: options.gate.op,
      gate: options.gate.gate,
      planDigest: active.digest,
      ...(options.gate.description ? { description: options.gate.description } : {}),
      ...(options.gate.timeout ? { timeout: options.gate.timeout } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    if (!check.satisfied) {
      // Nothing ran, so nothing is half-applied and there is nothing to
      // compensate. A gate is a fact, not a failure.
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
  const blockedBy = new Map<string, string>();
  let gatedFact: PendingGateRecord | undefined;

  const inPlan = new Set(active.order);
  /** Skip everything downstream of `root`, blaming `root` rather than the nearest edge. */
  const markBlocked = (root: string): void => {
    for (const [component, by] of downstreamWithin(components, inPlan, [root])) {
      if (blockedBy.has(component) || failed.includes(component)) continue;
      blockedBy.set(component, by);
    }
  };

  options.onProgress?.({ type: "run-start", waves: active.waves });

  for (const [waveIndex, wave] of active.waves.entries()) {
    const waveNum = waveIndex + 1;
    // A component whose upstream failed in an earlier wave is not dispatched.
    const runnable = wave.filter((name) => inPlan.has(name) && !blockedBy.has(name));
    if (runnable.length === 0) continue;

    options.onProgress?.({ type: "wave-start", wave: waveNum, components: runnable });
    const waveResults = await Promise.all(
      runnable.map(async (name) => {
        options.onProgress?.({ type: "component-start", wave: waveNum, component: name });
        const planned = options.plans?.[name];
        const result = await runComponentDeploy(
          byName.get(name)!,
          { ...fanOutContext(options, name), ...(planned && Object.keys(planned).length > 0 ? { plans: planned } : {}) },
          registry,
          componentOutputs,
          options.onProgress,
          gates,
        );
        options.onProgress?.({
          type: "component-done",
          wave: waveNum,
          component: name,
          status: result.status === "fail" ? "failed" : result.status,
        });
        options.onComponentSettled?.(result, componentOutputs[name]);
        return result;
      }),
    );
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

    const waveFailed = waveResults.some((r) => r.status === "fail");
    options.onProgress?.({
      type: "wave-done",
      wave: waveNum,
      status: waveFailed ? "failed" : waveResults.some((r) => r.status === "gated") ? "gated" : "ok",
    });
  }

  const blocked: FanOutSkip[] = [...blockedBy.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([component, by]) => ({ component, reason: "blocked" as const, blockedBy: by }));

  // A failure outranks a gate: something is actually broken, and reporting the
  // run as "waiting on a human" would hide it. Same precedence the driver uses.
  const status: FanOutRunResult["status"] = failed.length > 0 ? "fail" : gatedFact ? "gated" : "ok";
  options.onProgress?.({ type: "run-done", status: status === "fail" ? "failed" : status });

  return {
    plan: active,
    status,
    results,
    completed: [...completed].sort(),
    failed: [...failed].sort(),
    blocked,
    componentOutputs,
    ...(gatedFact ? { gate: gatedFact } : {}),
  };
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

  options.onProgress?.({ type: "run-start", waves: plan.waves });

  for (const [waveIndex, wave] of plan.waves.entries()) {
    const waveNum = waveIndex + 1;
    const runnable = wave.filter((name) => left.has(name) && !blockedBy.has(name));
    if (waveGate.only !== undefined && waveNum < waveGate.only) {
      if (runnable.length > 0) throw new EarlierWaveNotAppliedError(waveGate.only, waveNum, runnable);
      continue;
    }
    if (waveGate.only !== undefined && waveNum > waveGate.only) break;
    if (runnable.length === 0) continue;

    const gateName = waveGateName(waveGate.gate, waveNum);
    const contexts = new Map(runnable.map((name) => [name, fanOutContext(options, name)]));
    const planned = await Promise.all(
      runnable.map((name) => planComponent(byName.get(name)!, contexts.get(name)!, componentOutputs)),
    );

    const members: WaveMember[] = [];
    const plansFor = new Map<string, Record<string, unknown>>();
    const waveFailures: Array<{ component: string; error?: string }> = [];
    for (const p of planned) {
      if ("error" in p) {
        waveFailures.push({ component: p.component, error: p.error });
        continue;
      }
      members.push(...p.members);
      plansFor.set(p.component, p.plans);
    }

    let digest: string;
    try {
      // A wave where nothing planned has no set, and so no digest.
      digest = members.length > 0 ? waveSetDigest(members) : "";
    } catch (err) {
      // Two components planning the same root: there is no one plan for it.
      const error = err instanceof Error ? err.message : String(err);
      for (const name of plansFor.keys()) waveFailures.push({ component: name, error });
      plansFor.clear();
      digest = "";
    }
    for (const f of waveFailures) {
      failed.push(f.component);
      results.push(planFailure(f.component, f.error ?? "plan failed"));
      markBlocked(f.component);
    }

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
      continue;
    }

    const check = await evaluateGate(gates.port, {
      op: waveGate.op,
      gate: gateName,
      planDigest: digest,
      description: waveGate.description ?? `wave ${waveNum} of ${plan.waves.length}: ${toRun.join(", ")}`,
      ...(waveGate.timeout ? { timeout: waveGate.timeout } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
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
      break;
    }

    options.onProgress?.({ type: "wave-start", wave: waveNum, components: toRun });
    const waveResults = await Promise.all(
      toRun.map(async (name) => {
        options.onProgress?.({ type: "component-start", wave: waveNum, component: name });
        const plans = plansFor.get(name)!;
        const ctx = { ...contexts.get(name)!, ...(Object.keys(plans).length > 0 ? { plans } : {}) };
        const result = await runComponentDeploy(byName.get(name)!, ctx, registry, componentOutputs, options.onProgress, gates);
        options.onProgress?.({
          type: "component-done",
          wave: waveNum,
          component: name,
          status: result.status === "fail" ? "failed" : result.status,
        });
        options.onComponentSettled?.(result, componentOutputs[name]);
        return result;
      }),
    );
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
    options.onProgress?.({
      type: "wave-done",
      wave: waveNum,
      status: waveFailures.length > 0 ? "failed" : waveResults.some((r) => r.status === "gated") ? "gated" : "ok",
    });
  }

  const blocked: FanOutSkip[] = [...blockedBy.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([component, by]) => ({ component, reason: "blocked" as const, blockedBy: by }));

  const status: FanOutRunResult["status"] = failed.length > 0 ? "fail" : gatedFact ? "gated" : "ok";
  options.onProgress?.({ type: "run-done", status: status === "fail" ? "failed" : status });

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
