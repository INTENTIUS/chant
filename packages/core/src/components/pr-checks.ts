/**
 * The pull request's check job and the ref gate's status job (#4935), for
 * the forge lexicons to render beside the plan jobs: the pull request loop
 * (`chant build --pr-loop --check-job --ref-gate-status`) and the product
 * pipeline (`productPipelineJobs({ checkJob, refGateStatus })`).
 *
 * - The check job runs `chant ci check --base <base>` on the pull request's
 *   commit: the `ci.hooks.check` hooks the declaration at base names and the
 *   lexicons' check steps. A hook whose current local evidence the policy at
 *   base accepts is skipped (#4868). The job runs the change's code, so it
 *   follows the plan job's handover (#4295): the checkout script alone sees
 *   the forge token, every later step starts without it, and the check is
 *   the job's last step, handing `.chant/check` on as the job's outputs.
 *   It holds no runner key and no OIDC token for signing either (#4328).
 * - With `evidence` (#4870, #4869) the `check-evidence` job signs each hook
 *   that passed, by name, from the check job's report, in a job that checks
 *   out the target branch's commit and runs none of the change's code, as
 *   the plan note job signs `plan` and `policy` from the plan job's report.
 *   It pushes `refs/notes/chant/evidence`. On GitLab it runs in the target
 *   branch's plan notes pipeline (#4914), as the plan's `<plan job>-evidence`
 *   job does: `ci evidence sign --open` signs every open merge request's
 *   settled check job from its artifact, so no job of the merge request's
 *   own pipeline holds the key.
 * - The `ref-gate` job runs `chant workspace ref-gate status` (#4867) for
 *   the pull request's commit once the plan note and the check evidence are
 *   in: it reads the evidence notes, decides the update a merge into the
 *   target branch would make under the policy at base, and sets the
 *   `chant/ref-gate` status (or the policy's own status name), which a
 *   project can then make a required status. GitLab sets a status only with
 *   the protected token a target-branch pipeline holds (#4328), so there the
 *   job runs in the plan notes pipeline and posts for every open merge
 *   request into the branch (`ref-gate status --open`).
 *
 * The commit is the one the plan job checked out and every other status of
 * the loop names: `github.sha` on GitHub and Forgejo, `CI_COMMIT_SHA` in a
 * GitLab merge request pipeline.
 */

import type { ForgeKind } from "../pr-forge";
import { GITHUB_JOB_TOKEN } from "../ci-jobs";
import { assertPipelineEvidence, evidenceIdTokens, evidenceKeyEnv, evidenceKeyless, gitlabOpenEvidenceDir, openEvidenceLines, planEvidenceLines, type PipelineEvidence } from "../ci-evidence-jobs";
import { withProductBin } from "./pr-pipeline";

/** The check job's name (#4935). */
export const PR_CHECK_JOB = "check";

/** The job that signs the check job's hooks (#4935). */
export const PR_CHECK_EVIDENCE_JOB = "check-evidence";

/** The job that sets the ref gate's status (#4935). */
export const PR_REF_GATE_JOB = "ref-gate";

/** Where `chant ci check` writes its report: `CHECK_HOOKS_DIR` in ./check-hooks.ts, kept here so a generator does not load the check runner. */
export const PR_CHECK_REPORT_DIR = ".chant/check";

/** The artifact the check report is kept as. */
export const PR_CHECK_ARTIFACT = "chant-pr-check";

/** The check job (#4935): its command and the values it reads. */
export interface PrCheckJob {
  jobName: string;
  /** `chant ci check --base "$BASE_SHA"`, through the words' bin. */
  command: string;
  /** `BASE_SHA`, as the forge spells it. */
  env: Record<string, string>;
  /** The report directory it writes and hands on. */
  dir: string;
  /**
   * With `evidence`: the signing job's lines and variables. GitHub and
   * Forgejo run them in `check-evidence` after taking the report back;
   * GitLab in `check-evidence` in the target branch's plan notes pipeline
   * (#4914), for every open merge request's check job, keeping `dir`.
   * Signing keyless, the job asks for an OIDC token: `idToken` (GitHub's
   * `id-token: write`, Forgejo's `enable-openid-connect`) or GitLab's
   * `idTokens`.
   */
  evidence?: { jobName: string; lines: string[]; env: Record<string, string>; dir?: string; idToken?: true; idTokens?: Record<string, { aud: string }> };
}

/** The check job for `forge` (#4935), with the check evidence job when `evidence` names a runner identity. */
export function prCheckJob(forge: ForgeKind, opts: { bin?: string; evidence?: PipelineEvidence; noForks?: boolean } = {}): PrCheckJob {
  assertPipelineEvidence(opts.evidence);
  const gitlab = forge === "gitlab";
  const base = gitlab ? "$CI_MERGE_REQUEST_DIFF_BASE_SHA" : "${{ github.event.pull_request.base.sha }}";
  const job: PrCheckJob = {
    jobName: PR_CHECK_JOB,
    command: withProductBin('chant ci check --base "$BASE_SHA"', opts.bin),
    env: { BASE_SHA: base },
    dir: PR_CHECK_REPORT_DIR,
  };
  const evidence = opts.evidence;
  if (!evidence) return job;
  const key = evidenceKeyEnv(forge, evidence);
  const bin = opts.bin ? { bin: opts.bin } : {};
  if (gitlab) {
    // #4914: the job runs in the target branch's plan notes pipeline and signs every open merge request's
    // settled check job from its artifact; no job of a merge request pipeline holds the key.
    const dir = gitlabOpenEvidenceDir(PR_CHECK_JOB);
    return {
      ...job,
      evidence: {
        jobName: PR_CHECK_EVIDENCE_JOB,
        // A fork's check job runs too, as it holds nothing; with noForks (a product plan's forks: "skip") its hooks are not signed for.
        lines: openEvidenceLines({ job: PR_CHECK_JOB, dir: PR_CHECK_REPORT_DIR, out: dir, ...bin, ...(opts.noForks ? { noForks: true } : {}) }),
        env: key,
        dir,
        ...(evidenceKeyless(evidence) ? { idTokens: evidenceIdTokens(evidence) } : {}),
      },
    };
  }
  return {
    ...job,
    evidence: {
      jobName: PR_CHECK_EVIDENCE_JOB,
      lines: planEvidenceLines({ dir: PR_CHECK_REPORT_DIR, at: '"$HEAD_SHA"', base: '"$BASE_SHA"', result: '"$CHECK_RESULT"', ...bin }),
      env: { HEAD_SHA: "${{ github.sha }}", BASE_SHA: base, CHECK_RESULT: `\${{ needs.${PR_CHECK_JOB}.result }}`, ...key },
      ...(evidenceKeyless(evidence) ? { idToken: true as const } : {}),
    },
  };
}

/** The ref gate's status job (#4935): its lines and the values they read. */
export interface PrRefGateJob {
  jobName: string;
  /** The fetches of the pull request's commit and the evidence notes, before the command. */
  setup: string[];
  /** `chant workspace ref-gate status`, through the words' bin. */
  command: string;
  /** The values the lines read, as the forge spells them, the token included on GitHub and Forgejo. */
  env: Record<string, string>;
}

/**
 * The ref gate's status job for `forge` (#4935). `branch` is the target
 * branch on GitHub and Forgejo (default `main`); GitLab's job runs in a
 * pipeline of the target branch and names it from `CI_COMMIT_BRANCH`.
 */
export function prRefGateJob(forge: ForgeKind, opts: { bin?: string; branch?: string } = {}): PrRefGateJob {
  const notes = "'+refs/notes/chant/evidence:refs/notes/chant/evidence'";
  if (forge === "gitlab") {
    return {
      jobName: PR_REF_GATE_JOB,
      // The heads are fetched by the command, one merge request at a time.
      setup: [`git fetch --quiet --no-tags origin ${notes} || true`],
      command: withProductBin('chant workspace ref-gate status --open --ref "refs/heads/$CI_COMMIT_BRANCH" --base "$CI_COMMIT_SHA"', opts.bin),
      env: {},
    };
  }
  const branch = opts.branch ?? "main";
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch)) throw new Error(`the ref gate's branch ${JSON.stringify(branch)} is not a branch name`);
  return {
    jobName: PR_REF_GATE_JOB,
    setup: [`git fetch --quiet --no-tags origin "$HEAD_SHA" ${notes} || git fetch --quiet --no-tags origin "$HEAD_SHA" || true`],
    command: withProductBin(`chant workspace ref-gate status --ref refs/heads/${branch} --at "$HEAD_SHA" --base "$BASE_SHA"`, opts.bin),
    env: { HEAD_SHA: "${{ github.sha }}", BASE_SHA: "${{ github.event.pull_request.base.sha }}", GITHUB_TOKEN: GITHUB_JOB_TOKEN },
  };
}

export { CHECK_JOB_FLOOR, GITLAB_OPEN_EVIDENCE_FLOOR, PR_LOOP_EVIDENCE_FLOOR, REF_GATE_STATUS_JOB_FLOOR } from "../release-floors";
