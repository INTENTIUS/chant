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
 */

import { composeChangeSet, verifyChangeSetDigest, type ChangeSetDocument, type ChangeSetEntry, type ChangeSetPart } from "../change-set";
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
import { deployContext, type DriverComponent, type DriverComponentResult } from "./driver";
import { deployUnits } from "./deploy-units";
import { runFanOut, type FanOutRunResult } from "./fan-out-run";
import { remainingFanOut, type ComponentChangeSignal, type FanOutPlan } from "./fan-out";
import type { PrApplyRecord } from "./fan-out-record";
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
  /** The set {@link planPrSet} planned and the gate approved, or {@link resumePrSet}'s set. */
  set: PrPlanSet;
  onProgress?: (event: RunProgressEvent) => void;
  /**
   * What an earlier attempt at this approved set applied (#3464): its
   * components, which are reported applied and not run again, and the
   * outputs they left.
   */
  resumed?: { completed: string[]; outputs: Record<string, Record<string, unknown>> };
  /** Called as each component settles, so an attempt record survives a kill (`runFanOut`). */
  onComponentSettled?: (result: DriverComponentResult, outputs: Record<string, unknown> | undefined) => void;
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
    ...(options.onComponentSettled ? { onComponentSettled: options.onComponentSettled } : {}),
  });
  const completed = new Set(run.completed);
  const priorCompleted = new Set(options.resumed?.completed ?? []);
  /**
   * Whether a dependency's outputs moved from what the plans read: by this
   * run's apply, or by the earlier attempt's when the record kept them.
   */
  const movedBy = (dep: string): boolean => {
    if (completed.has(dep)) return !sameJson(before[dep], run.componentOutputs[dep]);
    const earlier = options.resumed?.outputs;
    return priorCompleted.has(dep) && earlier !== undefined && dep in earlier && !sameJson(before[dep], earlier[dep]);
  };
  const blocked = new Set(run.blocked.map((b) => b.component));
  const errorOf = (component: string): string | undefined => {
    const result = run.results.find((r) => r.component === component);
    if (result?.status === "gated") return `stopped at its own gate ${result.gate?.gate ?? ""}`.trim();
    return result?.records.find((r) => r.status === "fail")?.error;
  };
  const byName = new Map(options.components.map((c) => [c.name, c]));
  const members = options.set.members.map((m): PrMember => {
    if (priorCompleted.has(m.component)) return { ...m, status: "applied" };
    if (completed.has(m.component)) {
      const moved = (byName.get(m.component)?.dependsOn ?? [])
        .filter(movedBy)
        .sort();
      return { ...m, status: "applied", ...(moved.length > 0 ? { inputsMoved: moved } : {}) };
    }
    if (blocked.has(m.component)) return { ...m, status: "blocked" };
    const error = errorOf(m.component);
    return { ...m, status: "failed", ...(error ? { error } : {}) };
  });
  return { members, status: run.status === "ok" ? "applied" : "failed", run };
}

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
  /** Components an earlier attempt at the approved set applied (#3464). */
  resumed?: string[];
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
