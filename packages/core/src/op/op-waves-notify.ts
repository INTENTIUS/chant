/**
 * What an Op waves job tells people (#3761), when the spec has `notify`.
 *
 * A wave that waits for an approval (exit 3) sends `waiting` with the
 * approval command, the digest and, under `pr-review`, the pull request to
 * review. A share job that refused a run whose plan moved (exit 4) sends
 * `refused`. A wave whose plan, apply or stage hook failed (exit 1) sends
 * `failed`. A wave the product's policy refused (exit 7, #3821) sends
 * `refused` with the runs it denied, and one whose apply was held by another
 * run (exit 5) sends `refused` with status `held`, and one whose decision
 * point refused it (exit 8, #3836) sends `refused` with status `point`; one that stood down for a
 * newer run (exit 6) sends nothing. A share job of a waiting wave sends nothing, since its deciding
 * job already did, unless a hook in the share job itself held it (#3762). Delivery is `../notify.ts`: it never throws, and the job's exit code
 * is what the wave decided.
 */

import { makeNotifyEvent, notifyConfigProblem, sendNotify, type NotifyDelivery, type NotifyFields, type SendNotifyOptions } from "../notify";
import { CHANT_EXIT } from "../exit-codes";
import type { OpWavesSpec } from "./op-waves";
import type { RunOpWaveResult } from "./op-waves-run";

/** How the job ended: the wave's result, or the error that stopped it. */
export type OpWaveOutcome = { result: RunOpWaveResult; error?: undefined } | { result?: undefined; error: string };

/** The event a wave job sends, or undefined when it sends none. */
export function opWaveNotifyFields(spec: OpWavesSpec, k: number, outcome: OpWaveOutcome, job: { share?: number; group?: string } = {}): NotifyFields | undefined {
  const wave = spec.waves[k - 1];
  const name = wave?.name;
  const label = `wave ${k}${name ? ` (${name})` : ""} of ${spec.name}`;
  if (outcome.error !== undefined) {
    return { source: "chant", event: "failed", summary: `${label} failed`, wave: { number: k, ...(name ? { name } : {}) }, targets: [], reason: outcome.error, exitCode: 1 };
  }
  const { result } = outcome;
  const decision = result.decision;
  const base = {
    source: "chant",
    wave: { number: k, ...(name ? { name } : {}), ...(decision?.gate ? { gate: decision.gate } : {}) },
    ...(decision?.digest ? { digest: decision.digest } : {}),
    exitCode: result.exitCode,
  };
  if (result.exitCode === CHANT_EXIT.waiting) {
    if (!decision) return undefined;
    // A share job's wait (or a job group's, #3914) was announced by its deciding job, unless a hook in this job held it (#3762).
    const heldHere = result.hooks.filter((h) => h.outcome === "held");
    if ((job.share !== undefined || job.group !== undefined) && heldHere.length === 0) return undefined;
    const review = decision.review?.pr !== undefined && decision.review.url ? { review: { pr: decision.review.pr, url: decision.review.url } } : {};
    return {
      ...base,
      event: "waiting",
      status: "waiting",
      summary: `${label} waits for an approval`,
      targets: decision.members.map((m) => m.member),
      approve: { command: decision.approve ?? `chant approve ${decision.op} ${decision.gate} --plan ${decision.digest}`, ...review },
      ...(decision.heldOn
        ? { reason: `held on ${decision.heldOn.op} / ${decision.heldOn.gate} by ${decision.heldOn.hook}` }
        : decision.heldBy?.length
        ? { reason: `held by ${decision.heldBy.join(", ")}` }
        : decision.review?.reason
          ? { reason: decision.review.reason }
          : {}),
    };
  }
  if (result.exitCode === CHANT_EXIT.declined && decision?.refused?.reason === "point") {
    // #3836: the gate's decision point was answered with an answer it does not pass on.
    return {
      ...base,
      event: "refused",
      status: "point",
      summary: `${label} refused: decision point ${decision.point?.name ?? ""} answered ${JSON.stringify(decision.point?.answer?.answer ?? null)}`,
      targets: decision.refused.runs,
      ...(decision.refused.message ? { reason: decision.refused.message } : {}),
    };
  }
  if (result.exitCode === CHANT_EXIT.denied && decision?.refused) {
    // #3821: the product's policy denied a run, and no override counts for it.
    return {
      ...base,
      event: "refused",
      status: decision.refused.reason === "override-moved" ? "override-moved" : "denied",
      summary: `${label} refused: the policy denied ${decision.refused.runs.join(", ")}`,
      targets: decision.refused.runs,
      reason:
        decision.refused.reason === "override-moved"
          ? "an override stands for an earlier plan or other rules, so it counts for nothing"
          : "the policy denied these runs, and no override counts for them",
    };
  }
  // #3821: an apply that stood down for a newer run is no news; one held by another run is refused.
  if (result.exitCode === CHANT_EXIT.superseded && result.outcome?.outcome === "stood-down") return undefined;
  if (result.exitCode === CHANT_EXIT.held && result.outcome?.outcome === "held") {
    const holder = result.outcome.holder;
    return {
      ...base,
      event: "refused",
      status: "held",
      summary: `${label} applied nothing: another run${holder ? ` (${holder.run})` : ""} holds what it changes`,
      targets: decision?.members.map((m) => m.member) ?? [],
      reason: result.outcome.reason ?? `another run${holder ? `, ${holder.run},` : ""} holds what the apply changes; apply again once it is done`,
    };
  }
  if (result.exitCode === CHANT_EXIT.moved) {
    return {
      ...base,
      event: "refused",
      status: "moved",
      summary: `${label}${jobPart(job)} refused ${result.moved.length} run${result.moved.length === 1 ? "" : "s"} whose plan moved since the wave was decided`,
      targets: result.moved,
      reason: "their plans moved since the wave was decided, so they were not applied",
    };
  }
  if (result.exitCode !== 0) {
    const hooks = result.hooks.filter((h) => h.outcome === "failed").map((h) => `${h.moment} hook ${h.name}${h.target ? ` (${h.target})` : ""}`);
    if (result.failed.length === 0 && hooks.length > 0) {
      return { ...base, event: "failed", status: "failed", summary: `${label} failed: ${hooks.join(", ")} failed`, targets: [], reason: `${hooks.join(", ")} exited non-zero` };
    }
    return {
      ...base,
      event: "failed",
      status: "failed",
      summary: `${label} failed: ${result.failed.length > 0 ? `${result.failed.join(", ")} did not apply` : `exit ${result.exitCode}`}`,
      targets: result.failed,
      ...(result.failed.length > 0 ? { reason: `the apply command failed for ${result.failed.join(", ")}` } : {}),
    };
  }
  return undefined;
}

/** `, share 2,`, `, job group prod,` or `, share 2 of job group prod,`; empty for a wave's own job. */
function jobPart(job: { share?: number; group?: string }): string {
  if (job.group !== undefined) return `, ${job.share !== undefined ? `share ${job.share} of ` : ""}job group ${job.group},`;
  return job.share !== undefined ? `, share ${job.share},` : "";
}

/** Send what the job's outcome calls for to what `spec.notify` names. Never throws. */
export async function notifyOpWave(
  spec: OpWavesSpec,
  k: number,
  outcome: OpWaveOutcome,
  job: { share?: number; group?: string } = {},
  options: SendNotifyOptions = {},
): Promise<NotifyDelivery[]> {
  // A spec whose notify the run refused (it may name a URL in place of a variable) sends nothing.
  if (!spec.notify || notifyConfigProblem(spec.notify) !== undefined) return [];
  try {
    const fields = opWaveNotifyFields(spec, k, outcome, job);
    if (!fields) return [];
    return await sendNotify(spec.notify, makeNotifyEvent(fields, { ...(options.env ? { env: options.env } : {}) }), options);
  } catch (e) {
    (options.log ?? ((line: string) => process.stderr.write(line + "\n")))(`notify: nothing was sent: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
