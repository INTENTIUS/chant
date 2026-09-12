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
 */

import {
  runComponentDeploy,
  type DriverComponent,
  type DriverComponentResult,
  type GateContext,
} from "./driver";
import { downstreamWithin, remainingFanOut, type FanOutPlan, type FanOutProgress, type FanOutSkip } from "./fan-out";
import { evaluateGate, gitGateLedgerPort, type GateLedgerPort } from "../op/gate";
import type { RunProgressEvent } from "./run-progress";
import type { CapabilityRegistry } from "./capability";
import type { PendingGateRecord } from "../lifecycle/gate-ledger";

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
  /** What an earlier attempt at this same plan already did. */
  progress?: FanOutProgress;
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
        const result = await runComponentDeploy(
          byName.get(name)!,
          { env: options.env, component: name, vars: options.vars },
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
