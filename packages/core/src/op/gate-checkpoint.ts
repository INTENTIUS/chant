/**
 * Resuming a run at an approved gate (#3947, epic #3946).
 *
 * Before this, a run that stopped at a gate kept nothing but its record:
 * after `chant approve`, the next `chant run <op>` began again at the first
 * phase and recomputed every step before the gate, so a value could not be
 * carried across a gate with `stepOutput`. A gate with `resume: true` keeps
 * the outputs the steps after it need, and the next run starts at the gate.
 *
 * Stopping. The run works out which outputs cross the gate from the Op's own
 * references ({@link resumeGatesOf}): an output of a step before the gate
 * that a step at or after it references, in the main phases, `onFailure` or
 * the gate's own `approval` context. It writes them to a checkpoint
 * (`../lifecycle/gate-checkpoint.ts`) and puts the checkpoint's digest on
 * the pending fact. An output an activity contract marks secret is never
 * stored, and the gate then doesn't resume ({@link checkpointBlocked}).
 *
 * Resuming. {@link decideGateResume} picks the last resume gate whose
 * standing pending fact carries a checkpoint and has an approval that copied
 * it. It resumes there only when the fact hasn't expired, the checkpoint file
 * matches the digest the approver saw and names the fact's run, and this run
 * is at the same commit and environment. Any failed check starts the run at
 * the first phase and the reason is reported. The executor then re-runs the
 * step that produced the gate's `plan`, and starts at the first phase if the
 * digest moved, so live drift between the approval and the apply is still
 * caught (`./local-executor.ts`).
 */

import type { ActivityStep, GateStep, OpConfig, StepDefinition } from "./types";
import { WORK_LEASE_STEP_ID } from "./types";
import { collectStepOutputRefs, isStepOutputRef, type StepOutputRef } from "./step-output-ref";
import { gateName } from "./gate-name";
import { readsSecretOutput, type ActivityContract, type ActivityContractIssue } from "./activity-contract";
import type { GateLedgerPort } from "./gate";
import { isPendingGateExpired, latestPendingGate, type PendingGateRecord } from "../lifecycle/gate-ledger";
import { isApprovalSpent } from "../lifecycle/gate-applied";
import { samePlanDigest } from "../lifecycle/plan-digest";
import {
  checkpointOutputs,
  gateCheckpointDigest,
  gateCheckpointPath,
  isCheckpointRunId,
  parseGateCheckpoint,
  type GateCheckpoint,
} from "../lifecycle/gate-checkpoint";

/** A top-level activity step of a main phase, where it sits. */
interface Producer {
  step: ActivityStep;
  phaseIndex: number;
  stepIndex: number;
}

/** A gate that resumes, and what resuming at it needs. */
export interface ResumeGate {
  step: GateStep;
  name: string;
  phaseIndex: number;
  /** The gate's index among its phase's steps. */
  stepIndex: number;
  /** The step the gate's `plan` names, which a resumed run runs again. Absent when the plan is a literal or there is none. */
  planStep?: Producer;
  /** Ids of the steps before the gate whose outputs the checkpoint stores, in authored order. The plan step is not among them. */
  stored: string[];
  /** The references that read a stored output, for the secret check. */
  crossing: StepOutputRef[];
}

/** The step-output references a step reads when it runs: its args, a gate's plan, approval context and point inputs, and an effect's receipt and nested steps. */
function refsOfStep(step: StepDefinition): StepOutputRef[] {
  if (step.kind === "activity") return collectStepOutputRefs(step.args);
  if (step.kind === "gate") {
    const point = typeof step.point === "object" ? step.point.inputs : undefined;
    return [
      ...(isStepOutputRef(step.plan) ? [step.plan] : []),
      ...collectStepOutputRefs(step.approval?.context),
      ...collectStepOutputRefs(point),
    ];
  }
  return [...collectStepOutputRefs(step.receipt), ...step.steps.flatMap(refsOfStep)];
}

/** Every gate step of `config` with `resume: true` that isn't at the top of a main phase. */
function misplacedResumeGates(config: Pick<OpConfig, "phases" | "onFailure">): Array<{ phase: string; gate: GateStep }> {
  const out: Array<{ phase: string; gate: GateStep }> = [];
  for (const phase of config.phases) {
    for (const step of phase.steps) {
      if (step.kind === "effect") for (const n of step.steps) if (n.kind === "gate" && n.resume) out.push({ phase: phase.name, gate: n });
    }
  }
  for (const phase of config.onFailure ?? []) {
    for (const step of phase.steps) {
      if (step.kind === "gate" && step.resume) out.push({ phase: phase.name, gate: step });
      if (step.kind === "effect") for (const n of step.steps) if (n.kind === "gate" && n.resume) out.push({ phase: phase.name, gate: n });
    }
  }
  return out;
}

/**
 * The gates of `config` that resume, at the top of a main phase, in authored
 * order, each with the outputs a checkpoint at it stores. A gate that asks a
 * decision point, or one in an Op with a `workLease`, is left out: OPS016
 * refuses both, and a run treats them as gates that don't resume.
 */
export function resumeGatesOf(config: Pick<OpConfig, "phases" | "onFailure" | "workLease">): ResumeGate[] {
  if (config.workLease) return [];
  const out: ResumeGate[] = [];
  config.phases.forEach((phase, phaseIndex) => {
    phase.steps.forEach((step, stepIndex) => {
      if (step.kind !== "gate" || !step.resume || step.point !== undefined) return;
      // The steps that have finished when the run reaches the gate. In a
      // parallel phase the gates are decided before any activity starts.
      const before = new Map<string, Producer>();
      config.phases.forEach((p, pi) => {
        if (pi > phaseIndex) return;
        p.steps.forEach((s, si) => {
          if (s.kind !== "activity" || !s.id) return;
          if (pi === phaseIndex && (p.parallel || si >= stepIndex)) return;
          before.set(s.id, { step: s, phaseIndex: pi, stepIndex: si });
        });
      });
      const planStep = isStepOutputRef(step.plan) ? before.get(step.plan.step) : undefined;

      // What reads them: the gate and every step after it, the compensation
      // phases, the work lease, and the plan step, which runs again.
      const after: StepDefinition[] = [
        ...(phase.parallel ? phase.steps : phase.steps.slice(stepIndex)),
        ...config.phases.slice(phaseIndex + 1).flatMap((p) => p.steps),
        ...(config.onFailure ?? []).flatMap((p) => p.steps),
        ...(planStep ? [planStep.step] : []),
      ];
      const crossing = after.flatMap(refsOfStep).filter((ref) =>
        ref.step !== WORK_LEASE_STEP_ID && ref.step !== planStep?.step.id && before.has(ref.step),
      );
      const ids = new Set(crossing.map((r) => r.step));
      const stored = [...before.values()]
        .filter((p) => ids.has(p.step.id!))
        .sort((a, b) => a.phaseIndex - b.phaseIndex || a.stepIndex - b.stepIndex)
        .map((p) => p.step.id!);
      out.push({ step, name: gateName(step), phaseIndex, stepIndex, ...(planStep ? { planStep } : {}), stored, crossing });
    });
  });
  return out;
}

/** The step id that produced `ref`, and its activity, among the steps before `gate`. */
function producerOf(config: Pick<OpConfig, "phases">, ref: StepOutputRef): ActivityStep | undefined {
  for (const phase of config.phases) {
    for (const step of phase.steps) if (step.kind === "activity" && step.id === ref.step) return step;
  }
  return undefined;
}

/**
 * Why a checkpoint at `gate` can't hold what the steps after it read, or
 * undefined when it can (#3947): a reference to an output the producer's
 * contract marks secret. Secret outputs are never stored.
 */
export function checkpointBlocked(
  config: Pick<OpConfig, "phases">,
  gate: ResumeGate,
  contracts: ReadonlyMap<string, Pick<ActivityContract, "secret">> | undefined,
): string | undefined {
  if (!contracts) return undefined;
  for (const ref of gate.crossing) {
    const producer = producerOf(config, ref);
    if (producer && readsSecretOutput(contracts.get(producer.fn), ref.path)) {
      const what = ref.path ? `output "${ref.path}"` : "output";
      return `step "${ref.step}"'s ${what} is secret (the ${producer.fn} contract marks it), and a checkpoint never stores a secret`;
    }
  }
  return undefined;
}

/**
 * OPS016's check (#3947): what is wrong with the gates of `config` that set
 * `resume`. A gate that resumes must sit at the top of a main phase, must not
 * ask a decision point, must not be in an Op with a `workLease`, must name a
 * plan step that runs before it when its plan is a reference, and must not
 * need a secret output after it.
 */
export function validateGateResume(
  config: Pick<OpConfig, "name" | "phases" | "onFailure" | "workLease">,
  contracts?: ReadonlyMap<string, ActivityContract>,
): ActivityContractIssue[] {
  const issues: ActivityContractIssue[] = [];
  const issue = (phase: string, gate: GateStep, message: string) =>
    issues.push({ opName: config.name, phase, fn: `gate:${gateName(gate)}`, message });

  for (const { phase, gate } of misplacedResumeGates(config)) {
    issue(phase, gate, "resume is supported only on a gate at the top of a main phase, not in onFailure or inside an effect");
  }
  config.phases.forEach((phase) => {
    for (const step of phase.steps) {
      if (step.kind !== "gate" || !step.resume) continue;
      if (config.workLease) issue(phase.name, step, "a gate can't resume in an Op that runs under a workLease");
      if (step.point !== undefined) issue(phase.name, step, "a gate that asks a decision point can't resume");
    }
  });
  for (const gate of resumeGatesOf(config)) {
    const phase = config.phases[gate.phaseIndex]!.name;
    if (isStepOutputRef(gate.step.plan) && !gate.planStep) {
      issue(phase, gate.step, `its plan names step "${gate.step.plan.step}", which must be an activity that runs before the gate at the top of a main phase, so a resumed run can run it again`);
    }
    const blocked = checkpointBlocked(config, gate, contracts);
    if (blocked) issue(phase, gate.step, `can't resume: ${blocked}`);
  }
  return issues;
}

/**
 * Build the checkpoint a run stores when it stops at `gate`, or say why it
 * stores none: a secret output, an unknown commit, a run id that can't name
 * a file, or an output JSON can't hold.
 */
export function buildGateCheckpoint(
  config: Pick<OpConfig, "name" | "phases">,
  gate: ResumeGate,
  input: {
    runId: string;
    commit: string | undefined;
    environment?: string;
    planDigest?: string;
    outputs: ReadonlyMap<string, unknown>;
    contracts?: ReadonlyMap<string, Pick<ActivityContract, "secret">>;
  },
): { checkpoint: GateCheckpoint } | { blocked: string } {
  const secret = checkpointBlocked(config, gate, input.contracts);
  if (secret) return { blocked: secret };
  if (input.commit === undefined) return { blocked: "the commit this run is at could not be read, and a resumed run must be at the same one" };
  if (!isCheckpointRunId(input.runId)) return { blocked: `the run id "${input.runId}" can't name a checkpoint file` };
  const stored = checkpointOutputs(input.outputs, gate.stored);
  if ("unstorable" in stored) return { blocked: `step "${stored.unstorable}"'s output can't be stored as JSON` };
  return {
    checkpoint: {
      version: 1,
      op: config.name,
      gate: gate.name,
      runId: input.runId,
      commit: input.commit,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.planDigest !== undefined ? { planDigest: input.planDigest } : {}),
      outputs: stored.outputs,
    },
  };
}

/** What {@link decideGateResume} found. */
export type GateResumeDecision =
  | { kind: "none" }
  | { kind: "refused"; gate: string; reason: string }
  | { kind: "resume"; gate: ResumeGate; checkpoint: GateCheckpoint; digest: string; pending: PendingGateRecord };

/**
 * Decide whether this run resumes, and at which gate. The last resume gate
 * whose standing pending fact carries a checkpoint, and which an approval
 * recorded since then copied, is the candidate. Approved gates are tried
 * from the last one back, so a run that resumed at one gate and stopped at a
 * later one resumes at the later one next time.
 *
 * Reads the gate ledger and the checkpoint file and writes nothing. A gate
 * with no checkpoint, or none an approval copied, is not a candidate: the run
 * starts at the first phase as before, and says nothing.
 */
export async function decideGateResume(
  port: GateLedgerPort,
  config: Pick<OpConfig, "name" | "phases" | "onFailure" | "workLease">,
  input: { now: string; commit: string | undefined; environment?: string },
): Promise<GateResumeDecision> {
  const gates = resumeGatesOf(config);
  if (gates.length === 0) return { kind: "none" };
  const ledger = await port.read(config.name);
  const spent = port.readApplied ? await port.readApplied(config.name) : [];
  const at = (iso: string) => new Date(iso).getTime();

  for (const gate of [...gates].reverse()) {
    const standing = latestPendingGate(ledger.pending, gate.name);
    const digest = standing?.checkpointDigest;
    if (!standing || digest === undefined) continue;
    const approved = ledger.resolutions.some(
      (r) =>
        r.gate === gate.name && r.checkpointDigest === digest && at(r.timestamp) >= at(standing.timestamp) &&
        samePlanDigest(r.planDigest, standing.planDigest) && !isApprovalSpent(spent, r),
    );
    if (!approved) continue;

    const refuse = (reason: string): GateResumeDecision => ({ kind: "refused", gate: gate.name, reason });
    if (isPendingGateExpired(standing, input.now)) return refuse(`its pending fact expired at ${standing.expiresAt}`);
    if (!standing.runId) return refuse("its pending fact names no run");
    const { dir, file } = gateCheckpointPath(config.name, standing.runId);
    const text = port.readCheckpoint ? await port.readCheckpoint(config.name, standing.runId) : null;
    if (text === null) return refuse(`the checkpoint ${dir}/${file} is not on the ledger`);
    const checkpoint = parseGateCheckpoint(text);
    if (checkpoint === null) return refuse(`${dir}/${file} is not a checkpoint`);
    let actual: string;
    try {
      actual = gateCheckpointDigest(checkpoint);
    } catch {
      return refuse(`${dir}/${file} is not a checkpoint`);
    }
    if (actual !== digest) return refuse(`${dir}/${file} does not match the digest the approver saw (${digest}, the file is ${actual})`);
    if (checkpoint.op !== config.name || checkpoint.gate !== gate.name || checkpoint.runId !== standing.runId) {
      return refuse(`${dir}/${file} is for ${checkpoint.op} / ${checkpoint.gate}, run ${checkpoint.runId}`);
    }
    if (!samePlanDigest(checkpoint.planDigest, standing.planDigest)) return refuse(`${dir}/${file} names another plan than the pending fact`);
    if (input.commit === undefined) return refuse("the commit this run is at could not be read");
    if (input.commit !== checkpoint.commit) {
      return refuse(`the run that stopped there was at commit ${checkpoint.commit.slice(0, 12)}, and this one is at ${input.commit.slice(0, 12)}`);
    }
    if (input.environment !== checkpoint.environment) {
      return refuse(`the run that stopped there was for environment ${checkpoint.environment ?? "(none)"}, and this one is for ${input.environment ?? "(none)"}`);
    }
    const missing = gate.stored.find((id) => !(id in checkpoint.outputs));
    if (missing !== undefined) return refuse(`${dir}/${file} holds no output for step "${missing}"`);
    return { kind: "resume", gate, checkpoint, digest, pending: standing };
  }
  return { kind: "none" };
}
