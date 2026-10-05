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
 * ## Dependents read the outputs standing now
 *
 * A member that reads another one's output through `stackOutput()` is
 * planned with the value that output has now, read through the capability's
 * `outputs` (`readComponentOutputs`). When the change moves that output, the
 * dependent's approved plan still carries the old value; the apply applies
 * it as approved and marks the member `inputsMoved`, and the next run plans
 * it against the new value. A change that must carry a moved output through
 * its dependents in one rollout is what gated waves are for (#3049): each
 * wave is planned after the one before it applied.
 */

import { composeChangeSet, type ChangeSetDocument, type ChangeSetPart } from "../change-set";
import { evaluateGate, type GateCheck, type GateLedgerPort } from "../op/gate";
import {
  memberCounts,
  PR_REPORT_CONTRACT,
  PR_REPORT_SCHEMA_ID,
  type PrApproval,
  type PrMember,
  type PrRefusal,
  type PrReport,
  type PrStatus,
} from "../pr-loop";
import { deployContext, type DriverComponent } from "./driver";
import { deployUnits } from "./deploy-units";
import { runFanOut, type FanOutRunResult } from "./fan-out-run";
import type { ComponentChangeSignal, FanOutPlan } from "./fan-out";
import type { CapabilityRegistry } from "./capability";
import type { RunProgressEvent } from "./run-progress";
import { planWaveComponent, readComponentOutputs } from "./wave-plan";

export interface PrPlanSetOptions {
  /** Every component in the project. */
  components: DriverComponent[];
  /** The fan-out the change derives (`planFanOut`). Its `order` is what is planned. */
  plan: FanOutPlan;
  registry: CapabilityRegistry;
  env: string;
  vars?: Record<string, unknown>;
  /** Outputs supplied by the caller (`--seed-outputs`). They win over outputs read here. */
  seededOutputs?: Record<string, Record<string, unknown>>;
}

/** Every member of a pull request, planned. */
export interface PrPlanSet {
  /** The change-set document over every member. Its digest is what the gate binds. */
  doc: ChangeSetDocument;
  members: PrMember[];
  /** Per component, per member: what its steps hand `run`, so it applies this plan. */
  plans: Record<string, Record<string, unknown>>;
  /** The outputs the plans read: the seeds, and each dependency's outputs as they stood. */
  outputs: Record<string, Record<string, unknown>>;
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
 * Plan every component in `plan.order`, a wave at a time, each against the
 * outputs its dependencies have now. Never throws for a component that fails
 * to plan: it becomes a failed member, and `failed` is set.
 */
export async function planPrSet(options: PrPlanSetOptions): Promise<PrPlanSet> {
  const byName = new Map(options.components.map((c) => [c.name, c]));
  const outputs: Record<string, Record<string, unknown>> = { ...(options.seededOutputs ?? {}) };
  const read = new Set(Object.keys(outputs));
  const parts: ChangeSetPart[] = [];
  const componentOf = new Map<string, string>();
  const plans: Record<string, Record<string, unknown>> = {};
  let failed = false;

  for (const wave of options.plan.waves) {
    // The dependencies' outputs first, each read once. A dependency that
    // cannot say leaves its references unresolved, which its dependent's
    // plan reports if it needs them.
    for (const name of wave) {
      for (const dep of byName.get(name)?.dependsOn ?? []) {
        if (read.has(dep) || !byName.has(dep)) continue;
        read.add(dep);
        const found = await readComponentOutputs(byName.get(dep)!, options.registry, deployContext(options, dep), outputs);
        if (found) outputs[dep] = found;
      }
    }
    const planned = await Promise.all(
      wave.map((name) => planWaveComponent(byName.get(name)!, options.registry, deployContext(options, name), outputs)),
    );
    for (const p of planned) {
      const component = byName.get(p.component)!;
      if ("error" in p) {
        failed = true;
        for (const part of failedParts(component, p.error)) {
          parts.push(part);
          componentOf.set(part.member.member, p.component);
        }
        continue;
      }
      plans[p.component] = p.plans;
      for (const part of p.parts) {
        parts.push(part);
        componentOf.set(part.member.member, p.component);
      }
    }
  }

  const doc = composeChangeSet(parts);
  const members: PrMember[] = doc.members.map((m) => ({
    member: m.member,
    component: componentOf.get(m.member) ?? m.member,
    planDigest: m.planDigest,
    status: m.status === "failed" ? "plan-failed" : "planned",
    counts: memberCounts(doc, m.member),
    ...(m.error ? { error: m.error } : {}),
  }));
  return { doc, members, plans, outputs, failed };
}

/**
 * A ledger that reads the real one and records nothing. The plan stage
 * decides the gate only to say where the approval stands; it runs the pull
 * request's own code and holds no write access to `chant/lifecycle`.
 */
export function readOnlyLedger(port: GateLedgerPort): GateLedgerPort {
  return {
    read: (op) => port.read(op),
    ...(port.approvalRule ? { approvalRule: (gate: string) => port.approvalRule!(gate) } : {}),
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

export interface PrApplyOptions {
  components: DriverComponent[];
  plan: FanOutPlan;
  registry: CapabilityRegistry;
  env: string;
  vars?: Record<string, unknown>;
  /** The set {@link planPrSet} planned and the gate approved. */
  set: PrPlanSet;
  onProgress?: (event: RunProgressEvent) => void;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Apply the approved plans in dependency order. A failed component blocks
 * its dependents and nothing else (`runFanOut`).
 */
export async function applyPrSet(options: PrApplyOptions): Promise<{ members: PrMember[]; status: "applied" | "failed"; run: FanOutRunResult }> {
  const before = options.set.outputs;
  const run = await runFanOut(options.plan, options.components, options.registry, {
    env: options.env,
    ...(options.vars ? { vars: options.vars } : {}),
    plans: options.set.plans,
    componentOutputs: { ...before },
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  const completed = new Set(run.completed);
  const blocked = new Set(run.blocked.map((b) => b.component));
  const errorOf = (component: string): string | undefined => {
    const result = run.results.find((r) => r.component === component);
    if (result?.status === "gated") return `stopped at its own gate ${result.gate?.gate ?? ""}`.trim();
    return result?.records.find((r) => r.status === "fail")?.error;
  };
  const byName = new Map(options.components.map((c) => [c.name, c]));
  const members = options.set.members.map((m): PrMember => {
    if (completed.has(m.component)) {
      const moved = (byName.get(m.component)?.dependsOn ?? [])
        .filter((dep) => completed.has(dep) && !sameJson(before[dep], run.componentOutputs[dep]))
        .sort();
      return { ...m, status: "applied", ...(moved.length > 0 ? { inputsMoved: moved } : {}) };
    }
    if (blocked.has(m.component)) return { ...m, status: "blocked" };
    const error = errorOf(m.component);
    return { ...m, status: "failed", ...(error ? { error } : {}) };
  });
  return { members, status: run.status === "ok" ? "applied" : "failed", run };
}

export interface PrReportInput {
  stage: "plan" | "apply";
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
    approval: input.approval,
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
