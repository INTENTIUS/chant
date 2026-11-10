/**
 * How a generated waves pipeline signs each wave's checks (#4926), for the
 * forge lexicons to render. No import beyond the spec's helpers and the
 * claim file names, so the generators' bundles stay small.
 *
 * With a pipeline `evidence` identity, each wave's own or deciding job:
 *
 * - runs the wave's policy (`holds.policy`) as a step of its own before the
 *   command, `chant run wave --policy-only`; on GitLab, which reports no
 *   steps, as a `<wave job>-policy` job the wave job needs. Its result is
 *   the forge's to report, and `policy:<wave>` is signed from it alone.
 * - is followed by `<wave job>-evidence`, which runs none of the change's
 *   code, reads the wave job's record through the forge and signs with
 *   `chant ci evidence sign --from-job`: `policy:<wave>` when the wave has a
 *   policy, and `plan:<wave>` too when the wave trades cloud credentials and
 *   signs keyless, since after the trade no step of the wave job may request
 *   the signing token (#4869).
 * - signs `plan:<wave>` in its command step otherwise, as before (#4870).
 *
 * A wave with no policy and no keyless cloud trade renders as before.
 * A later wave whose `evidence.requires` names a check an earlier wave's
 * evidence job signs needs that job, so it reads the evidence once signed.
 */

import { EVIDENCE_SOURCES_ENV, WAVE_EVIDENCE_ENV, type EvidenceSourceSpec } from "../ci-evidence-claims";
import { opWaveBinArgv, opWaveChecksDir, type OpWaveJob, type OpWavesSpec } from "./op-waves";

export { EVIDENCE_SOURCES_ENV, WAVE_EVIDENCE_ENV };

/** The `id` of a wave job's policy step on GitHub and Forgejo, which the command step's `if:` reads. */
export const OP_WAVE_POLICY_STEP_ID = "chant-policy";

/** How one wave job signs its checks (#4926). */
export interface OpWaveEvidencePlan {
  /** The wave's two check names. */
  plan: string;
  policy: string;
  /** The wave runs its policy as a step (GitLab: a job) of its own. */
  policyStep: boolean;
  /** `CHANT_WAVE_EVIDENCE` on the command step: `plan` signs plan only, `job` signs nothing there. Unset: as before. */
  commandMode?: "plan" | "job";
  /** The command step holds the signing identity (a key, or keyless with the job's own token). */
  commandSigns: boolean;
  /** The evidence job after the wave job, and the checks it signs. */
  evidenceJob?: { name: string; checks: string[] };
}

/**
 * What wave job `job` renders for its evidence, or undefined when the job
 * signs nothing (a share or job group's job, or no `evidence` on the
 * pipeline). `keylessCloud` is whether the job signs keyless and trades
 * cloud credentials.
 */
export function opWaveEvidencePlan(spec: Pick<OpWavesSpec, "holds" | "waves">, job: Pick<OpWaveJob, "kind" | "jobName" | "wave">, opts: { signs: boolean; keylessCloud: boolean }): OpWaveEvidencePlan | undefined {
  if (!opts.signs || (job.kind !== "wave" && job.kind !== "decide")) return undefined;
  const name = spec.waves[job.wave - 1]!.name;
  const plan = `plan:${name}`;
  const policy = `policy:${name}`;
  const policyStep = spec.holds?.policy === true;
  const checks = [...(opts.keylessCloud ? [plan] : []), ...(policyStep ? [policy] : [])];
  if (checks.length === 0) return { plan, policy, policyStep, commandSigns: true };
  return { plan, policy, policyStep, commandMode: opts.keylessCloud ? "job" : "plan", commandSigns: !opts.keylessCloud, evidenceJob: { name: `${job.jobName}-evidence`, checks } };
}

/** The GitLab job a wave's policy runs in (#4926). */
export function opWavePolicyJobName(job: Pick<OpWaveJob, "jobName">): string {
  return `${job.jobName}-policy`;
}

/** The policy step's command: the wave job's own, with `--policy-only`. */
export function opWavePolicyCommand(job: Pick<OpWaveJob, "command">): string[] {
  return [...job.command, "--policy-only"];
}

/** The policy step's name on GitHub and Forgejo, which the evidence job finds it by. */
export function opWavePolicyStepName(wave: number, name: string): string {
  return `Check wave ${wave} (${name})'s plans against the policy`;
}

/**
 * The evidence job's `CHANT_EVIDENCE_SOURCES`: on GitHub and Forgejo the
 * command step for `plan:<wave>` and the policy step for `policy:<wave>`, by
 * name; on GitLab the wave job and its policy job.
 */
export function opWaveEvidenceSources(forge: "github" | "forgejo" | "gitlab", plan: OpWaveEvidencePlan, job: Pick<OpWaveJob, "jobName" | "wave">, waveName: string, commandStep: string): Record<string, EvidenceSourceSpec> {
  const out: Record<string, EvidenceSourceSpec> = {};
  for (const check of plan.evidenceJob?.checks ?? []) {
    if (forge === "gitlab") out[check] = check === plan.policy ? { job: opWavePolicyJobName(job) } : {};
    else out[check] = { step: check === plan.policy ? opWavePolicyStepName(job.wave, waveName) : commandStep };
  }
  return out;
}

/**
 * The evidence job's lines (#4926): note the base and check it out, so the
 * setup and the product's command after it are the base's code and none of
 * the change's runs, then sign from the wave job. `sha` is the run's commit
 * as the shell reads it; the first line keeps the base in
 * {@link OP_WAVE_EVIDENCE_BASE_VAR}.
 */
export function opWaveEvidenceLines(spec: Pick<OpWavesSpec, "name" | "base">, plan: OpWaveEvidencePlan, job: Pick<OpWaveJob, "jobName">, opts: { sha: string; bin?: string }): { checkout: string[]; sign: string[] } {
  const base = spec.base ?? "HEAD^1";
  const quoted = `'${base.replace(/'/g, "'\\''")}'`;
  return {
    checkout: [`${OP_WAVE_EVIDENCE_BASE_VAR}="$(git rev-parse --verify ${quoted}^{commit})" || exit 1`, `git checkout --quiet --detach "$${OP_WAVE_EVIDENCE_BASE_VAR}" || exit 1`],
    sign: [
      [
        ...opWaveBinArgv(opts.bin),
        "ci evidence sign --from-job",
        job.jobName,
        "--check-id",
        plan.evidenceJob!.checks.join(","),
        "--claims",
        opWaveChecksDir(spec),
        "--at",
        opts.sha,
        "--base",
        `"$${OP_WAVE_EVIDENCE_BASE_VAR}"`,
      ].join(" "),
    ],
  };
}

/** The variable the evidence job keeps the base commit in between its lines. */
export const OP_WAVE_EVIDENCE_BASE_VAR = "CHANT_EVIDENCE_BASE";

/**
 * The evidence jobs each later wave job needs (#4926): those of earlier waves
 * that sign a check `evidence.requires` names, by the wave's number.
 */
export function opWaveEvidenceNeeds(spec: Pick<OpWavesSpec, "evidence">, plans: ReadonlyArray<{ wave: number; plan: OpWaveEvidencePlan | undefined }>): (wave: number) => string[] {
  const requires = new Set(spec.evidence?.requires ?? []);
  return (wave) => plans.filter((p) => p.wave < wave && p.plan?.evidenceJob && p.plan.evidenceJob.checks.some((c) => requires.has(c))).map((p) => p.plan!.evidenceJob!.name);
}
