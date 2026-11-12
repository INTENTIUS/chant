/**
 * The rest of an apply that stopped, under the approval it applied under
 * (#5047), with the spec's `approvals.remainder` and `approvals.spend`, both
 * read at base.
 *
 * A wave that applies under an approval writes its applied line on
 * `chant/lifecycle` (`_gates/<op>/applied.jsonl`, #3784) first. Under
 * `remainder` that line carries each change the approved plans make: a run's
 * resource, by the engine's address, and the resource's digest (the
 * capability's `resourceDigests`), with the commit and the run (`resume`,
 * which `chant run resume` starts again once it is gone). Only an engine that
 * records each resource as its apply returns (the `resource` lock grain, such
 * as choudoufu's) plans exactly what it did not apply after a stop, so a wave
 * with a changing run on another grain, or with no resource digests, records
 * no changes and never resumes as a remainder. The job that applies the
 * whole wave (a split wave's record job) writes how the apply ended, a
 * `finished` line; a killed apply writes none.
 *
 * Run again at the same commit (the resume re-runs the stopped job), the
 * wave plans what is left. That plan has another digest, so the spent
 * approval would not count. It does when every change the plans make is one
 * the stopped apply's line names, with the same digest: the ones it no longer
 * makes are done, since the config is the same and the engine records each
 * resource it applied. Any other change, a digest member that is no run
 * beyond the approved ones, or another commit, leaves the wave to wait for an
 * approval of its own. The wave then applies under the stopped line, writes
 * no applied line of its own, and writes that line's finished line.
 *
 * A split wave's applying job (#4987) re-plans its runs through the step: a
 * run whose plan moved since the gate job's decision applies when its plan
 * makes only changes the decision recorded, with the same digests.
 *
 * A wave whose plans change nothing closes the newest stopped apply of its
 * gate as applied, since something applied the rest. With
 * `approvals.spendStanding` a wave its gate lets through spends an approval
 * of its digest that stands (`./op-waves-run.ts`).
 *
 * Pure: no git, no ledger, no clock.
 */

import type { AppliedGateChange, AppliedGateRecord, FinishedGateRecord } from "../lifecycle/gate-applied";
import { finishedApply } from "../lifecycle/gate-applied";
import { samePlanDigest } from "../lifecycle/plan-digest";
import { OP_WAVE_COST_MEMBER } from "./op-waves-capability-spec";

export type { AppliedGateChange } from "../lifecycle/gate-applied";

export { OP_WAVES_REMAINDER_FLOOR, OP_WAVES_REMAINDER_PARITY_FLOOR } from "../release-floors";

/** A planned run, as the remainder reads it: its member, whether its plan is empty, and its resources' digests. */
export interface OpWaveRemainderMember {
  member: string;
  empty?: boolean;
  resources?: Record<string, string>;
}

/** The lock grain of each run's step plan, by target. */
export type OpWaveRemainderGrains = ReadonlyMap<string, { lock?: { grain: string } }> | undefined;

/**
 * Every change the plans make, sorted by target and address, or undefined
 * when a run that changes something did not plan through the step on the
 * `resource` grain or gave no resource digests: the wave cannot resume as a
 * remainder.
 */
export function opWaveApprovedChanges(members: readonly OpWaveRemainderMember[], grains: OpWaveRemainderGrains): AppliedGateChange[] | undefined {
  const out: AppliedGateChange[] = [];
  for (const m of members) {
    if (m.empty === true) continue;
    if (grains?.get(m.member)?.lock?.grain !== "resource" || m.resources === undefined) return undefined;
    for (const [address, digest] of Object.entries(m.resources)) out.push({ target: m.member, address, digest });
  }
  return out.sort((a, b) => (a.target === b.target ? (a.address < b.address ? -1 : a.address > b.address ? 1 : 0) : a.target < b.target ? -1 : 1));
}

const time = (iso: string): number => new Date(iso).getTime();

/** The newest applied line of `gate`, oldest wins a tie by order. */
function newestLine(applied: readonly AppliedGateRecord[], gate: string): AppliedGateRecord | undefined {
  return applied.filter((a) => a.gate === gate).reduce<AppliedGateRecord | undefined>((n, a) => (!n || time(a.timestamp) >= time(n.timestamp) ? a : n), undefined);
}

/**
 * The apply of `gate` a wave at `commit` takes up: the gate's newest applied
 * line, when it names changes, was written at `commit`, and no finished line
 * says it applied. Undefined when there is none.
 */
export function opWaveStoppedApply(applied: readonly AppliedGateRecord[], finished: readonly FinishedGateRecord[], gate: string, commit: string | undefined): AppliedGateRecord | undefined {
  const line = newestLine(applied, gate);
  if (!line?.changes || commit === undefined || line.commit !== commit) return undefined;
  return finishedApply(finished, line)?.result === "applied" ? undefined : line;
}

/** The newest applied line of `gate` that names changes and has no finished line at all: what a wave that changes nothing closes. */
export function opWaveUnfinishedApply(applied: readonly AppliedGateRecord[], finished: readonly FinishedGateRecord[], gate: string): AppliedGateRecord | undefined {
  const line = newestLine(applied, gate);
  return line?.changes && !finishedApply(finished, line) ? line : undefined;
}

/** Whether the plans now are the rest of the approved changes. */
export type OpWaveCover =
  | { covered: true; remaining: AppliedGateChange[]; done: AppliedGateChange[] }
  | { covered: false; why: string };

const key = (c: Pick<AppliedGateChange, "target" | "address">): string => `${c.target} ${c.address}`;

/**
 * The digest members that are no run whose digest follows from the plans
 * (#5056): the cost member, `(monthly cost)`, chant's `holds.cost` and
 * terragucci's alike, which digests the wave's monthly change. Part of the
 * wave applied, so the rest costs less and the digest moves; every change is
 * still compared, so the cover leaves it out on both sides.
 */
export const OP_WAVE_REMAINDER_FOLLOWS: readonly string[] = [OP_WAVE_COST_MEMBER];

/**
 * Whether `now`, the changes the plans make, are the rest of `approved`:
 * each one approved with the same digest. The approved ones it no longer
 * makes are done. `extras` are the digest members that are no run, now and
 * as approved: each one now must be approved with the same digest, except
 * the ones whose digest follows from the plans ({@link OP_WAVE_REMAINDER_FOLLOWS}).
 */
export function opWaveCoverRemainder(
  approved: readonly AppliedGateChange[],
  now: readonly AppliedGateChange[] | undefined,
  extras: { now?: readonly { member: string; planDigest: string }[]; approved?: readonly { member: string; planDigest: string }[] } = {},
): OpWaveCover {
  if (!now) return { covered: false, why: "a run that changes something plans on no resource grain, or gave no resource digests" };
  const was = new Map(approved.map((c) => [key(c), c]));
  const moved = now.filter((c) => was.get(key(c))?.digest !== c.digest).map(key);
  if (moved.length > 0) return { covered: false, why: `${moved.join(", ")} ${moved.length === 1 ? "is a change" : "are changes"} the approved plans did not make` };
  const extra = (extras.now ?? []).filter((e) => !OP_WAVE_REMAINDER_FOLLOWS.includes(e.member) && !(extras.approved ?? []).some((a) => a.member === e.member && samePlanDigest(a.planDigest, e.planDigest))).map((e) => e.member);
  if (extra.length > 0) return { covered: false, why: `${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} not as the approved set held ${extra.length === 1 ? "it" : "them"}` };
  const planned = new Set(now.map(key));
  return { covered: true, remaining: [...now], done: approved.filter((c) => !planned.has(key(c))) };
}

/**
 * A run's plan in a split wave's applying job, against the changes the gate
 * job's decision recorded (#5047): covered when it makes only changes of
 * that run the decision holds, with the same digests.
 */
export function opWaveRunCovered(approved: readonly AppliedGateChange[], target: string, plan: OpWaveRemainderMember, grains: OpWaveRemainderGrains): OpWaveCover {
  const now = opWaveApprovedChanges([plan], grains);
  return opWaveCoverRemainder(approved.filter((c) => c.target === target), now?.map((c) => ({ ...c, target })));
}
