/**
 * What an Op waves job tells people (#3761), when the spec has `notify`.
 *
 * A wave that waits for an approval (exit 3) sends `waiting` with the
 * approval command, the digest and, under `pr-review`, the pull request to
 * review. A share job that refused a run whose plan moved (exit 4) sends
 * `refused`. A wave whose plan, apply or stage hook failed (exit 1) sends
 * `failed`. A share job of a waiting wave sends nothing, since its deciding
 * job already did, unless a hook in the share job itself held it (#3762). Delivery is `../notify.ts`: it never throws, and the job's exit code
 * is what the wave decided.
 */

import { makeNotifyEvent, notifyConfigProblem, sendNotify, type NotifyDelivery, type NotifyFields, type SendNotifyOptions } from "../notify";
import type { OpWavesSpec } from "./op-waves";
import type { RunOpWaveResult } from "./op-waves-run";

/** How the job ended: the wave's result, or the error that stopped it. */
export type OpWaveOutcome = { result: RunOpWaveResult; error?: undefined } | { result?: undefined; error: string };

/** The event a wave job sends, or undefined when it sends none. */
export function opWaveNotifyFields(spec: OpWavesSpec, k: number, outcome: OpWaveOutcome, job: { share?: number } = {}): NotifyFields | undefined {
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
  if (result.exitCode === 3) {
    if (!decision) return undefined;
    // A share job's wait was announced by its deciding job, unless a hook in this job held it (#3762).
    const heldHere = result.hooks.filter((h) => h.outcome === "held");
    if (job.share !== undefined && heldHere.length === 0) return undefined;
    const review = decision.review?.pr !== undefined && decision.review.url ? { review: { pr: decision.review.pr, url: decision.review.url } } : {};
    return {
      ...base,
      event: "waiting",
      status: "waiting",
      summary: `${label} waits for an approval`,
      targets: decision.members.map((m) => m.member),
      approve: { command: decision.approve ?? `chant approve ${decision.op} ${decision.gate} --plan ${decision.digest}`, ...review },
      ...(decision.heldBy?.length
        ? { reason: `held by ${decision.heldBy.join(", ")}` }
        : decision.review?.reason
          ? { reason: decision.review.reason }
          : {}),
    };
  }
  if (result.exitCode === 4) {
    return {
      ...base,
      event: "refused",
      status: "moved",
      summary: `${label}${job.share !== undefined ? `, share ${job.share},` : ""} refused ${result.moved.length} run${result.moved.length === 1 ? "" : "s"} whose plan moved since the wave was decided`,
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

/** Send what the job's outcome calls for to what `spec.notify` names. Never throws. */
export async function notifyOpWave(
  spec: OpWavesSpec,
  k: number,
  outcome: OpWaveOutcome,
  job: { share?: number } = {},
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
