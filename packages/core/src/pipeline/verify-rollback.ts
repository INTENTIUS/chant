/**
 * A rollback a stage requests when its verify or its soak fails (#5328).
 *
 * A stage sets `onVerifyFail: "rollback"` in `.chant/pipeline.ts` to opt in.
 * The default, `"hold"`, is what every stage did before: the stage stays as
 * applied, or mixed, and `workspace status` prints the rollback line for a
 * person to run.
 *
 * Two failures count:
 *
 * - verify: a promote into the stage deployed, and a component's verify step
 *   (or any step after its apply) failed, so the run failed;
 * - soak: a check of the stage's soak failed while a promote out of it read
 *   the soak (`./soak-gate.ts`).
 *
 * On either, {@link requestStageRollback} writes three things on the stage's
 * ledger (`./stage-ledger.ts`): a `failed` line, with each member's state
 * ({@link memberStateOf}); then a `rollback-requested` line bound to the
 * stage's previous release, naming the members the rollback restores and
 * linking the failure; and the pending fact of gate `<stage>-rollback`
 * under the pipeline's op, bound to that release's digest. It sends a
 * `rollback-requested` notify event, and the command exits 3.
 *
 * The request applies nothing. `chant components rollback <stage>
 * --requested` reads it, passes it through {@link requestedRollbackGate}
 * and only then runs `components rollback --release` for the members it
 * names. That gate always waits for a person: a stage gate policy of `never`
 * lets a promote through, and never a requested rollback. It counts the
 * stage gate's approval rules and approval mode, only approvals given since
 * the request, and the run spends the approval it used. The `rolled-back`
 * line links the rollback to its request and its failure.
 *
 * No rollback is requested, and the line `rollback-held` says why, when the
 * stage ran no earlier release, when the newest earlier one is revoked or
 * no longer kept, or when no member left applied ran that release.
 *
 * The `failed` line names no rollback, so a separate reader of failures, such
 * as an agent trigger, reads it on its own; whatever that reader opens, the
 * request stays on the ledger until the rollback runs.
 */

import { createHash } from "node:crypto";
import type { DriverComponentResult } from "../components/driver";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import { gateSealRefusal } from "../lifecycle/gate-seal";
import { approveCommand, evaluateGate, type GateApprovalRule, type GateLedgerPort } from "../op/gate";
import type { ResolvedGateApproval } from "../op/gate-approval";
import { makeNotifyEvent, sendNotify, type NotifyConfig, type NotifyEvent } from "../notify";
import type { PipelineGateProof } from "./promote";
import type { PipelineOnVerifyFail, PipelineSpec, PipelineStage } from "./spec";
import type { StageLedgerPort, StageMemberState, StageMemberStateName, StagePauseLine, StageRelease } from "./stage-ledger";

/** How long a rollback request's pending fact stands. The request itself stays on the stage's ledger until the rollback runs. */
export const ROLLBACK_REQUEST_EXPIRY = "30d";

/** What a stage does when its verify or soak fails: its `onVerifyFail`, else `"hold"`. */
export function stageOnVerifyFail(stage: Pick<PipelineStage, "onVerifyFail"> | undefined): PipelineOnVerifyFail {
  return stage?.onVerifyFail ?? "hold";
}

/** The gate a stage's requested rollback passes, under the pipeline's op. */
export function stageRollbackGate(stage: string): string {
  return `${stage}-rollback`;
}

/** The command that carries out a stage's requested rollback once its gate passes. */
export function requestedRollbackCommand(stage: string): string {
  return `chant components rollback ${stage} --requested`;
}

/**
 * The state a run left one member in, from its result: `applied` when it
 * deployed; for a failed or gated one, `left-applied` when a step's change
 * stays (a `rollback-opted-out` record, an undo that failed, or a step that
 * ran before a gate stopped it), `rolled-back` when each step that ran was
 * undone, and `not-applied` when nothing of it ran.
 */
export function memberStateOf(result: Pick<DriverComponentResult, "status" | "records"> | undefined): StageMemberStateName {
  if (!result) return "not-applied";
  if (result.status === "ok") return "applied";
  const records = result.records;
  if (records.some((r) => r.status === "rollback-opted-out")) return "left-applied";
  // The forward failure is one `fail` record; another is an undo that failed.
  if (records.filter((r) => r.status === "fail").length > 1) return "left-applied";
  if (records.some((r) => r.status === "rolled-back")) return "rolled-back";
  if (result.status === "gated" && records.some((r) => r.status === "ok" && !r.kind.startsWith("gate:"))) return "left-applied";
  return "not-applied";
}

/** Each planned member's state after a run, in plan order. */
export function memberStatesOf(members: readonly string[], results: readonly Pick<DriverComponentResult, "component" | "status" | "records">[]): StageMemberState[] {
  return members.map((member) => ({ member, state: memberStateOf(results.find((r) => r.component === member)) }));
}

/**
 * The stage a held promotion's soak failure rolls back, and its members, or
 * undefined when the soak held for its clock or for a check that could not
 * be read (#5328). The stage is the one whose soak held (`heldBy`), which on
 * a later promote can be a canary upstream rather than the stage promoted
 * from or into.
 */
export function soakFailureOf(outcome: { passed: boolean; decision: { holds: readonly { reason: string; status?: string }[] }; heldBy?: { stage: string; members: string[] } }): { stage: string; members: string[] } | undefined {
  if (outcome.passed || !outcome.heldBy) return undefined;
  return outcome.decision.holds.some((h) => h.reason === "check" && h.status === "failed") ? outcome.heldBy : undefined;
}

/** The lines a failed run's records give, one per failed step: `<member> <phase>/<kind>: <error>`. */
export function failureDetail(results: readonly Pick<DriverComponentResult, "component" | "status" | "records">[]): string[] {
  const out: string[] = [];
  for (const result of results) {
    if (result.status !== "fail") continue;
    const failed = result.records.find((r) => r.status === "fail");
    if (failed) out.push(`${result.component} ${failed.phase}/${failed.kind}: ${failed.error ?? "failed"}`);
  }
  return out;
}

/** What a release check says: whether the release is kept, and the revocation's reason when its commit is revoked. */
export interface ReleaseCheck {
  kept: boolean;
  revoked: string | null;
}

/** The stage's previous release, or why there is none to go back to. */
export type PreviousRelease =
  | { status: "found"; release: StageRelease }
  | { status: "none" }
  | { status: "revoked"; release: StageRelease; reason: string }
  | { status: "not-kept"; release: StageRelease };

/**
 * The release the stage ran before the one that failed: the newest release
 * its ledger names outside `exclude`. Unlike `rollbackTarget`, a revoked or
 * no longer kept release is not passed over for an older one; it is the
 * answer, so the hold can say which release it is.
 */
export async function previousRelease(input: {
  records: readonly ReleaseRecord[];
  exclude: ReadonlySet<string>;
  check: (releaseDigest: string) => Promise<ReleaseCheck>;
  label?: (releaseDigest: string) => string | null;
}): Promise<PreviousRelease> {
  const newest = input.records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.releaseDigest !== undefined && !input.exclude.has(r.releaseDigest))
    .sort((a, b) => (a.r.timestamp === b.r.timestamp ? b.i - a.i : a.r.timestamp < b.r.timestamp ? 1 : -1))[0];
  if (!newest) return { status: "none" };
  const digest = newest.r.releaseDigest!;
  const release: StageRelease = { digest, label: input.label?.(digest) ?? null };
  const check = await input.check(digest);
  if (!check.kept) return { status: "not-kept", release };
  if (check.revoked !== null) return { status: "revoked", release, reason: check.revoked };
  return { status: "found", release };
}

/** Why no rollback is requested, as the `rollback-held` line and the promote say it. */
export function heldReason(stage: string, previous: Exclude<PreviousRelease, { status: "found" }>): string {
  const name = (r: StageRelease) => r.label ?? r.digest;
  if (previous.status === "none") return `stage ${stage} ran no earlier release, so there is nothing to roll back to`;
  if (previous.status === "revoked") return `stage ${stage}'s earlier release ${name(previous.release)} is revoked (${previous.reason}), so it is not restored`;
  return `stage ${stage}'s earlier release ${name(previous.release)} is no longer kept, so it cannot be restored`;
}

/**
 * Which members a rollback to `to` restores: each member left `applied` or
 * `left-applied` that ran release `to` in the stage. Every other member is
 * listed with why it is not restored.
 */
export function rollbackMembers(states: readonly StageMemberState[], records: readonly ReleaseRecord[], to: StageRelease): StageMemberState[] {
  return states.map((s) => {
    if (s.state === "rolled-back") return { ...s, rollback: "its own steps were undone when it failed" };
    if (s.state === "not-applied") return { ...s, rollback: "nothing of it applied" };
    // As `planReleaseRollback` reads it (`isApplyRecord`): a record that only says the component applied restores nothing.
    const ran = records.some((r) => r.component === s.member && r.releaseDigest === to.digest && r.digestKind !== "plan" && r.digestKind !== "deploy-input");
    return ran ? { ...s, rollback: "requested" } : { ...s, rollback: `it never ran release ${to.label ?? to.digest} in this stage` };
  });
}

/** The `failed` lines of a stage's ledger, oldest first: what a separate trigger reads. */
export function stageFailures(lines: readonly StagePauseLine[]): StagePauseLine[] {
  return lines.filter((l) => l.kind === "failed");
}

/**
 * The newest rollback request no `rolled-back` line has answered, or
 * undefined. With `failed`, only a request for that failed release counts.
 */
export function standingRollbackRequest(lines: readonly StagePauseLine[], failed?: string): StagePauseLine | undefined {
  const done = new Set(lines.filter((l) => l.kind === "rolled-back" && l.requestId).map((l) => l.requestId!));
  return [...lines].reverse().find((l) => l.kind === "rollback-requested" && l.id !== undefined && !done.has(l.id) && (failed === undefined || l.failed?.digest === failed));
}

/** A line's id: a digest of what it says and when. */
function lineId(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** One line in the words a person reads: each member and what the rollback does with it. */
export function memberLines(members: readonly StageMemberState[]): string[] {
  return members.map((m) => `${m.member}: ${m.state}${m.rollback === undefined ? "" : m.rollback === "requested" ? ", rolled back by the request" : `, not rolled back: ${m.rollback}`}`);
}

export interface StageRollbackInput {
  spec: Pick<PipelineSpec, "name" | "stages">;
  stage: string;
  failure: "verify" | "soak";
  /** The release that failed in the stage, or the promotion's digest when it named none. */
  failed: StageRelease;
  /** Each member's state. */
  members: readonly StageMemberState[];
  /** What the failure said, one line each. */
  detail: readonly string[];
  /** The stage's release ledger. */
  records: readonly ReleaseRecord[];
  /** Releases that are not earlier ones: the one that failed. */
  exclude: ReadonlySet<string>;
  check: (releaseDigest: string) => Promise<ReleaseCheck>;
  label?: (releaseDigest: string) => string | null;
  stages: StageLedgerPort;
  gates: GateLedgerPort;
  /** Who the lines name: the promote's actor. */
  by: string;
  now: Date;
  gitSha?: string;
  /** Where the request's notice goes. Absent: none is sent. */
  notify?: { config: NotifyConfig | undefined; source: string; send?: (config: NotifyConfig | undefined, event: NotifyEvent) => Promise<unknown> };
}

/** What {@link requestStageRollback} did. */
export type StageRollbackOutcome =
  /** The stage holds, as it always did: its `onVerifyFail` is `hold`. Nothing was written. */
  | { status: "hold" }
  /** A request for this failed release stands already; nothing new was written. */
  | { status: "standing"; request: StagePauseLine; exitCode: 3; lines: string[]; hint: string }
  | { status: "requested"; request: StagePauseLine; failure: StagePauseLine; exitCode: 3; lines: string[]; hint: string }
  /** No rollback could be requested; the stage holds, and `reason` says why. */
  | { status: "held"; failure: StagePauseLine; reason: string; lines: string[] };

/** Write a stage's failure and its rollback request. See the module comment. */
export async function requestStageRollback(input: StageRollbackInput): Promise<StageRollbackOutcome> {
  const stage = input.spec.stages.find((s) => s.name === input.stage);
  if (stageOnVerifyFail(stage) !== "rollback") return { status: "hold" };
  const { spec, stages, now } = input;
  const at = now.toISOString();
  const gate = stageRollbackGate(input.stage);
  const lines = await stages.read(spec.name, input.stage);
  const standing = standingRollbackRequest(lines, input.failed.digest);
  if (standing) {
    return {
      status: "standing",
      request: standing,
      exitCode: 3,
      lines: [`the rollback of stage ${input.stage} to ${standing.release?.label ?? standing.release?.digest} requested at ${standing.timestamp} still waits at ${spec.name} ${gate}`, ...memberLines(standing.members ?? [])],
      hint: requestHint(spec.name, input.stage, standing.release!, stage),
    };
  }

  const base = { version: 1 as const, pipeline: spec.name, stage: input.stage, by: input.by, timestamp: at };
  const failureId = lineId([spec.name, input.stage, input.failure, input.failed.digest, at]);
  const failure: StagePauseLine = { ...base, kind: "failed", id: failureId, failure: input.failure, failed: input.failed, members: [...input.members], ...(input.detail.length > 0 ? { detail: [...input.detail] } : {}) };
  await stages.append(failure);

  const previous = await previousRelease({ records: input.records, exclude: input.exclude, check: input.check, ...(input.label ? { label: input.label } : {}) });
  const failedLine = `${input.failure === "verify" ? "a verify" : "a soak check"} failed in stage ${input.stage} on ${input.failed.label ?? input.failed.digest}`;
  const held = async (reason: string, members: readonly StageMemberState[]): Promise<StageRollbackOutcome> => {
    await stages.append({ ...base, kind: "rollback-held", failureId, held: reason });
    return { status: "held", failure, reason, lines: [failedLine, ...memberLines(members)] };
  };
  if (previous.status !== "found") return held(heldReason(input.stage, previous), input.members);
  const members = rollbackMembers(input.members, input.records, previous.release);
  if (!members.some((m) => m.rollback === "requested")) {
    return held(`no member of stage ${input.stage} that the failure left applied ran release ${previous.release.label ?? previous.release.digest}, so none is rolled back`, members);
  }

  const requestId = lineId([spec.name, input.stage, "rollback", previous.release.digest, failureId]);
  const request: StagePauseLine = { ...base, kind: "rollback-requested", id: requestId, failureId, failed: input.failed, release: previous.release, members, gate };
  await stages.append(request);
  // The gate's pending fact, so the approval waits where every other approval waits.
  const what = previous.release.label ?? previous.release.digest;
  await evaluateGate(input.gates, {
    op: spec.name,
    gate,
    planDigest: previous.release.digest,
    releaseDigest: previous.release.digest,
    environment: input.stage,
    now: at,
    timeout: ROLLBACK_REQUEST_EXPIRY,
    description: `roll stage ${input.stage} back to release ${what} after ${input.failure === "verify" ? "a failed verify" : "a failed soak check"}: ${members.filter((m) => m.rollback === "requested").map((m) => m.member).join(", ")}`,
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    ...(stage?.gate?.quorum && stage.gate.quorum.length > 0 ? { approval: { quorum: stage.gate.quorum, mode: "enforce" as const } } : {}),
  });

  const hint = requestHint(spec.name, input.stage, previous.release, stage);
  if (input.notify) {
    const event = makeNotifyEvent({
      source: input.notify.source,
      event: "rollback-requested",
      project: spec.name,
      environment: input.stage,
      summary: `${failedLine}; a rollback to release ${what} waits for an approval at ${spec.name} ${gate}`,
      targets: members.filter((m) => m.rollback === "requested").map((m) => m.member),
      digest: previous.release.digest,
      approve: { command: approveCommand(spec.name, gate, input.stage, previous.release.digest, stage?.gate?.approval === "sealed") },
      rollback: {
        stage: input.stage,
        failure: input.failure,
        failed: input.failed,
        to: previous.release,
        gate,
        members: members.map((m) => ({ member: m.member, state: m.state, ...(m.rollback !== undefined ? { rollback: m.rollback } : {}) })),
        ...(input.detail.length > 0 ? { detail: [...input.detail] } : {}),
      },
      reason: failedLine,
      exitCode: 3,
      // One request is one event, so a receiver drops a repeat send of it.
      id: requestId,
    }, { now });
    try {
      await (input.notify.send ?? sendNotify)(input.notify.config, event);
    } catch {
      // A notice never changes the outcome.
    }
  }
  return {
    status: "requested",
    request,
    failure,
    exitCode: 3,
    lines: [failedLine, `requested the rollback of stage ${input.stage} to release ${what}; it waits at ${spec.name} ${gate}`, ...memberLines(members)],
    hint,
  };
}

function requestHint(pipeline: string, stage: string, to: StageRelease, spec: Pick<PipelineStage, "gate"> | undefined): string {
  return `Approve it with: ${approveCommand(pipeline, stageRollbackGate(stage), stage, to.digest, spec?.gate?.approval === "sealed")}, then run: ${requestedRollbackCommand(stage)}`;
}

/** What {@link requestedRollbackGate} decided. */
export type RequestedRollbackGate =
  | { passed: true; approval: GateResolutionRecord; lines: string[] }
  | { passed: false; exitCode: 3; code: "pipeline-rollback-waiting"; message: string; hint: string };

/**
 * The gate a requested rollback passes before it applies: gate
 * `<stage>-rollback` under the pipeline's op, bound to the release it goes
 * back to, with the stage gate's approval rules and mode. It always waits
 * for a person, whatever the stage's gate policy, and counts only an
 * approval given since the request and not spent by an earlier rollback.
 */
export async function requestedRollbackGate(input: {
  spec: Pick<PipelineSpec, "name" | "stages">;
  stage: string;
  request: StagePauseLine;
  port: GateLedgerPort;
  proof?: PipelineGateProof;
  now: Date;
  gitSha?: string;
}): Promise<RequestedRollbackGate> {
  const { spec, port, request } = input;
  const stage = spec.stages.find((s) => s.name === input.stage);
  const gate = stageRollbackGate(input.stage);
  const to = request.release!;
  const sealed = stage?.gate?.approval === "sealed";
  const own = (await port.approvalRule?.(gate)) ?? null;
  // #5354: under `sealed`, only an approval whose seal verifies at base counts, as at the stage's own gate.
  let rule: GateApprovalRule | null = own;
  if (sealed) {
    const signers = input.proof?.signers;
    const refuses = (a: GateResolutionRecord): string | null => (signers ? gateSealRefusal(signers, a) : "no signers at base prove a seal");
    rule = own ? { requirement: own.requirement, refuses: (a) => own.refuses(a) ?? refuses(a) } : { requirement: { gate, class: null }, refuses };
  }
  const approval: ResolvedGateApproval | undefined = stage?.gate?.quorum && stage.gate.quorum.length > 0 ? { quorum: stage.gate.quorum, mode: "enforce" } : undefined;
  const spent = (await port.readApplied?.(spec.name)) ?? [];
  const waiting: RequestedRollbackGate = {
    passed: false,
    exitCode: 3,
    code: "pipeline-rollback-waiting",
    message: `the rollback of stage ${input.stage} to release ${to.label ?? to.digest} waits for an approval at ${spec.name} ${gate}`,
    hint: `Approve it with: ${approveCommand(spec.name, gate, input.stage, to.digest, sealed)}, then run this again`,
  };
  const got = await evaluateGate(port, {
    rule,
    op: spec.name,
    gate,
    planDigest: to.digest,
    releaseDigest: to.digest,
    environment: input.stage,
    now: input.now.toISOString(),
    timeout: ROLLBACK_REQUEST_EXPIRY,
    spent,
    description: `roll stage ${input.stage} back to release ${to.label ?? to.digest}`,
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
    ...(approval ? { approval } : {}),
  });
  if (!got.satisfied) return waiting;
  // Only a person's approval given since the request counts: an approval the gate kept from before, or a policy's permit, does not.
  if (Date.parse(got.resolution.timestamp) < Date.parse(request.timestamp) || got.via === "policy" || got.via === "empty") return waiting;
  return { passed: true, approval: got.resolution, lines: [`${spec.name} ${gate}: approved by ${got.resolution.resolvedBy}`] };
}

/** A step a stage applies, as the build check reads it: the member's component and phase, or the pipeline's `defaults.step`. */
export interface RollbackStepView {
  /** Where the step sits: `component "api" step deploy/terraform-apply`, or `defaults.step`. */
  where: string;
  kind: string;
}

/** What the build check reads of a step's capability. */
export interface RollbackCapabilityView {
  /** Whether the capability answers `releaseInputs`, so a release records the files the step applies. */
  releaseInputs: boolean;
  /** Its `rollbackPolicy`, else `native` when it has a `rollback` and `none-by-design` when not, as COMP003 derives it. */
  rollbackPolicy: "native" | "none-by-design" | "needs-opt-out";
}

/** The step kind whose change no earlier release takes back. */
export const MIGRATION_STEP_KIND = "sql-migrate";

/**
 * Why `chant build` refuses `onVerifyFail: "rollback"` on a stage (#5328),
 * one line per step; empty when nothing refuses. A requested rollback is
 * `components rollback --release`, which applies the files an earlier
 * release recorded, so each step the stage applies has to be one that
 * applying an earlier release restores:
 *
 * - a `sql-migrate` step is refused: a migration that ran stays run;
 * - a step whose kind no registered capability has is refused, since
 *   nothing says what it does;
 * - a step whose capability changes nothing (`none-by-design`) passes;
 * - any other step passes only when its capability answers `releaseInputs`,
 *   as `terraform-apply` and `pulumi-up` do. Without it, the release records
 *   none of its files and the rollback has nothing of it to apply.
 *
 * A step's `noRollback` decides nothing here: it says the capability does not
 * undo a failed apply, and the rollback is a forward apply of the earlier
 * release, not an undo.
 */
export function verifyRollbackProblems(input: {
  spec: Pick<PipelineSpec, "stages">;
  steps: readonly RollbackStepView[];
  capability: (kind: string) => RollbackCapabilityView | undefined;
}): string[] {
  const stages = input.spec.stages.filter((s) => stageOnVerifyFail(s) === "rollback");
  if (stages.length === 0) return [];
  const why = (step: RollbackStepView): string | undefined => {
    if (step.kind === MIGRATION_STEP_KIND) return "it runs migrations, and applying an earlier release does not take back a migration that ran";
    const capability = input.capability(step.kind);
    if (!capability) return `no capability of kind "${step.kind}" is registered, so nothing says whether an earlier release restores it`;
    if (capability.rollbackPolicy === "none-by-design") return undefined;
    if (!capability.releaseInputs) return `its kind "${step.kind}" answers no releaseInputs, so a release records none of its files and components rollback --release has nothing of it to apply`;
    return undefined;
  };
  const out: string[] = [];
  for (const step of input.steps) {
    const reason = why(step);
    if (!reason) continue;
    for (const stage of stages) out.push(`stage "${stage.name}" sets onVerifyFail: "rollback", and ${step.where} cannot be rolled back that way: ${reason}; set onVerifyFail to "hold" on it`);
  }
  return out;
}

/** The line a requested rollback that ran writes: the members it restored, linked to its request and failure. */
export function rolledBackLine(input: { request: StagePauseLine; by: string; approval: GateResolutionRecord; now: Date }): StagePauseLine {
  const { request } = input;
  return {
    version: 1,
    kind: "rolled-back",
    pipeline: request.pipeline,
    stage: request.stage,
    by: input.by,
    timestamp: input.now.toISOString(),
    ...(request.id ? { requestId: request.id } : {}),
    ...(request.failureId ? { failureId: request.failureId } : {}),
    ...(request.release ? { release: request.release } : {}),
    ...(request.failed ? { failed: request.failed } : {}),
    members: (request.members ?? []).filter((m) => m.rollback === "requested"),
    gate: stageRollbackGate(request.stage),
    approval: { by: input.approval.resolvedBy, at: input.approval.timestamp, ...(input.approval.note ? { note: input.approval.note } : {}) },
  };
}
