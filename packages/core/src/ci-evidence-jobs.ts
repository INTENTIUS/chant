/**
 * What a generated pipeline adds to sign evidence for the named checks it
 * runs (#4870), for the forge lexicons to render. No import beyond the
 * words' bin swap, so the generators' bundles stay small.
 *
 * A project switches it on by naming the secret (GitHub, Forgejo) or CI/CD
 * variable (GitLab) that holds its runner key, the PEM key whose public half
 * `.chant/trust.json` lists under `runners`: the same secret the green
 * workflow takes as `--runner-key-secret`. Without it nothing is added and
 * every generated file is as before.
 *
 * - The plan note job (the product plan pipeline, GitHub and Forgejo) signs
 *   `plan` and `policy` from the plan job's report, after taking it back and
 *   before posting the note, which then says which checks were signed. The
 *   key is in that one step, in a job that runs none of the change's code.
 *   GitLab posts its notes from a target-branch pipeline that reads every
 *   open merge request, so there a job of its own after each plan job
 *   (`<plan job>-evidence`) signs from the plan job's artifact.
 * - A wave job (the waves pipeline) gets the key on its `chant run wave`
 *   step, and signs `plan:<wave>` and `policy:<wave>` once the wave is
 *   planned (../op/op-waves-evidence.ts).
 * - A product's check job runs `chant ci check` with the key in
 *   `CHANT_RUNNER_KEY`; the check runner signs each hook (./components/check-steps.ts).
 *
 * The key is a stored secret today. #4869 swaps it for the job's OIDC
 * identity: the steps stay where they are and request a token instead.
 */

import type { ForgeKind } from "./pr-forge";

/** The variable the signing steps read the key from. */
export const EVIDENCE_KEY_ENV = "CHANT_RUNNER_KEY";

export { CHECK_EVIDENCE_FLOOR } from "./release-floors";

/** A pipeline's runner identity (#4870). */
export interface PipelineEvidence {
  /** The secret (GitHub, Forgejo) or CI/CD variable (GitLab) holding the runner key as PEM. */
  runnerKeySecret: string;
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Refuse a secret name the forge could not hold. */
export function assertPipelineEvidence(evidence: PipelineEvidence | undefined): void {
  if (evidence === undefined) return;
  if (!SECRET_NAME.test(evidence.runnerKeySecret ?? "")) throw new Error(`evidence.runnerKeySecret ${JSON.stringify(evidence.runnerKeySecret)} is not a secret name: letters, digits and _, not starting with a digit`);
}

/** The signing step's key variable, from the forge's secret. */
export function evidenceKeyEnv(forge: ForgeKind, evidence: PipelineEvidence): Record<string, string> {
  return { [EVIDENCE_KEY_ENV]: forge === "gitlab" ? `$${evidence.runnerKeySecret}` : `\${{ secrets.${evidence.runnerKeySecret} }}` };
}

/**
 * The plan job's evidence step (#4870): fetch the planned commit (the note
 * job checks out the target branch's), then sign `plan` and `policy` from
 * the report directory. `result` is the plan job's result as the shell
 * reads it.
 */
export function planEvidenceLines(opts: { dir: string; at: string; base: string; result: string; bin?: string }): string[] {
  const chant = opts.bin ?? "chant";
  return [
    `git fetch --quiet --no-tags --depth=1 origin ${opts.at} || true`,
    `${chant} ci evidence sign --from-report ${opts.dir} --result ${opts.result} --at ${opts.at} --base ${opts.base}`,
  ];
}
