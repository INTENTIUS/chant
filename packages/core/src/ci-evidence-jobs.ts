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
 *   open merge request, so there a job of its own in that pipeline, before
 *   the note job (`<plan job>-evidence`), signs from each merge request's
 *   plan job artifact (#4914): a merge request pipeline is built from the
 *   change's own files, so no job in it may hold the key. The signing job
 *   names the environment {@link GITLAB_EVIDENCE_ENVIRONMENT}, which the
 *   key's variable is scoped to, protected; the jobs that run the change
 *   name none, so GitLab never hands them the key.
 * - A wave job (the waves pipeline) gets the key on its `chant run wave`
 *   step, and signs `plan:<wave>` and `policy:<wave>` once the wave is
 *   planned (../op/op-waves-evidence.ts). A wave with a policy runs it as a
 *   step of its own and a `<wave job>-evidence` job signs `policy:<wave>`
 *   from that step's result; a wave that trades cloud credentials and signs
 *   keyless signs `plan:<wave>` there too (#4926,
 *   ./op/op-waves-evidence-jobs.ts).
 * - A product's check job runs `chant ci check` with the key in
 *   `CHANT_RUNNER_KEY`; the check runner signs each hook (./components/check-steps.ts).
 *
 * With `identity: "oidc"` (#4869) the same steps sign keyless from the
 * job's OIDC identity: no secret, `CHANT_RUNNER_IDENTITY=oidc` on the
 * signing step, and the job asks the forge for a token, so no product adds
 * that itself: `id-token: write` on GitHub (Forgejo's dialect turns it into
 * `enable-openid-connect: true`), and on GitLab `id_tokens:` with
 * `CHANT_ID_TOKEN_SIGSTORE` for the signing audience. `.chant/trust.json`
 * at base lists the workflow's identity under `keyless`.
 */

import type { ForgeKind } from "./pr-forge";

/** The variable the signing steps read the key from. */
export const EVIDENCE_KEY_ENV = "CHANT_RUNNER_KEY";

/** The variable that makes a signing step sign keyless (#4869). */
export const EVIDENCE_IDENTITY_ENV = "CHANT_RUNNER_IDENTITY";

/** The GitLab `id_tokens` variable a keyless signing job's token comes in (#4869). */
export const EVIDENCE_ID_TOKEN_VAR = "CHANT_ID_TOKEN_SIGSTORE";

/** The audience a keyless signing job's token is requested for unless told: sigstore's. */
export const EVIDENCE_DEFAULT_AUDIENCE = "sigstore";

export { CHECK_EVIDENCE_FLOOR, CHECK_JOB_FLOOR, GITLAB_OPEN_EVIDENCE_FLOOR, KEYLESS_EVIDENCE_FLOOR, LOCAL_EVIDENCE_FLOOR, PR_LOOP_EVIDENCE_FLOOR, REF_GATE_STATUS_JOB_FLOOR, WAVE_EVIDENCE_JOB_FLOOR } from "./release-floors";

/**
 * The GitLab environment every signing job names (#4914), with `action:
 * access`, so it creates no deployment. Scope the runner key's CI/CD
 * variable to it and protect it: GitLab then hands the key only to the
 * signing jobs of a protected branch's pipeline, and to none of the jobs
 * that run a merge request's code.
 */
export const GITLAB_EVIDENCE_ENVIRONMENT = "chant-evidence";

/** Where a GitLab signing job keeps what it signed for each merge request (#4914): `.chant/evidence/<job>/<iid>/evidence.json`. */
export function gitlabOpenEvidenceDir(job: string): string {
  return `.chant/evidence/${job}`;
}

/**
 * The lines of a GitLab signing job in the target branch's plan notes
 * pipeline (#4914): `chant ci evidence sign --open` finds every open merge
 * request's newest `job`, reads its report from the job's artifact at
 * `dir`, fetches the head and signs it against the policy at the branch's
 * commit, and keeps each merge request's `evidence.json` under `out`.
 * With `noForks`, a merge request from a fork is not signed for, as a
 * product plan with `forks: "skip"` plans none.
 */
export function openEvidenceLines(opts: { job: string; dir: string; out: string; bin?: string; noForks?: boolean }): string[] {
  const chant = opts.bin ?? "chant";
  return [`${chant} ci evidence sign --open --job ${opts.job} --from-report ${opts.dir} --base "$CI_COMMIT_SHA" --output ${opts.out}${opts.noForks ? " --no-forks" : ""}`];
}

/**
 * A pipeline's runner identity (#4870): a runner key's secret, or (#4869)
 * the job's own OIDC identity. Exactly one.
 */
export interface PipelineEvidence {
  /** The secret (GitHub, Forgejo) or CI/CD variable (GitLab) holding the runner key as PEM. */
  runnerKeySecret?: string;
  /** `oidc` (#4869): sign keyless from the job's OIDC identity, which `.chant/trust.json` at base lists under `keyless.identities`. */
  identity?: "oidc";
  /** With `identity`: the token's audience, as `keyless.audience` in `.chant/trust.json` says. Default `sigstore`. */
  audience?: string;
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Refuse a secret name the forge could not hold, and an evidence block that names both identities or neither. */
export function assertPipelineEvidence(evidence: PipelineEvidence | undefined): void {
  if (evidence === undefined) return;
  if (evidence.identity !== undefined) {
    if (evidence.runnerKeySecret !== undefined) throw new Error("evidence names a runnerKeySecret and an identity; a pipeline signs with one of them (#4869)");
    if (evidence.identity !== "oidc") throw new Error(`evidence.identity ${JSON.stringify(evidence.identity)} is not oidc, the one identity chant signs with keyless`);
    if (evidence.audience !== undefined && !/^[\x21-\x7e]+$/.test(evidence.audience)) throw new Error(`evidence.audience ${JSON.stringify(evidence.audience)} is not printable ASCII with no space`);
    return;
  }
  if (!SECRET_NAME.test(evidence.runnerKeySecret ?? "")) throw new Error(`evidence.runnerKeySecret ${JSON.stringify(evidence.runnerKeySecret)} is not a secret name: letters, digits and _, not starting with a digit`);
}

/** Whether the pipeline signs keyless (#4869), so its signing jobs ask the forge for an OIDC token. */
export function evidenceKeyless(evidence: PipelineEvidence | undefined): boolean {
  return evidence?.identity === "oidc";
}

/** The GitLab `id_tokens:` a keyless signing job requests (#4869); empty with a runner key. */
export function evidenceIdTokens(evidence: PipelineEvidence | undefined): Record<string, { aud: string }> {
  return evidenceKeyless(evidence) ? { [EVIDENCE_ID_TOKEN_VAR]: { aud: evidence!.audience ?? EVIDENCE_DEFAULT_AUDIENCE } } : {};
}

/** The signing step's variables: the key from the forge's secret, or (#4869) `CHANT_RUNNER_IDENTITY=oidc`. */
export function evidenceKeyEnv(forge: ForgeKind, evidence: PipelineEvidence): Record<string, string> {
  if (evidenceKeyless(evidence)) return { [EVIDENCE_IDENTITY_ENV]: "oidc" };
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
