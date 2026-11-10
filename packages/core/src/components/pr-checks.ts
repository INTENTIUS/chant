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
 * GitLab merge request pipeline. On a GitHub `pull_request` run that is the
 * merge preview, and the status goes on the pull request's head, where the
 * forge shows and requires it (#4964, ../pr-forge-job.ts).
 *
 * #4964: a workspace member's pipeline takes all three. The check job runs
 * in the member's directory, the product's own service containers,
 * variables, lines and report directory come with `PrCheckJobOptions`, and
 * a product's own workflow renders the jobs through the lexicons'
 * `productCheckJobs`.
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

/**
 * A service container the check job starts beside it (#4964), such as a
 * throwaway database its hooks replay into. The job reaches it by `name`.
 * GitHub and Forgejo hold the job's steps until `health` passes; GitLab
 * does not wait, so a check job there waits in its `before` lines.
 */
export interface PrCheckService {
  /** The service's host name on the job's network: lower-case letters, digits, `.`, `_` and `-`. */
  name: string;
  image: string;
  /** The service container's environment. */
  env?: Record<string, string>;
  /** A command the forge runs in the service container until it passes (GitHub's and Forgejo's `--health-cmd`). */
  health?: string;
}

/**
 * The check job's own settings (#4964), as a product passes them in
 * `checkJob: { ... }`. `true` is all of them left out.
 */
export interface PrCheckJobOptions {
  /** Service containers beside the job. */
  services?: PrCheckService[];
  /** Variables of the check step, such as a service's URL. No forge token, runner key or `BASE_SHA`. */
  env?: Record<string, string>;
  /** Lines the check step runs before `chant ci check`, after the tokens are dropped, such as a wait for a service. */
  before?: string[];
  /** The report directory, repository-relative from the job's directory: `chant ci check --output <dir>`. Default `.chant/check`. */
  dir?: string;
}

/** The check job (#4935): its command and the values it reads. */
export interface PrCheckJob {
  jobName: string;
  /** `chant ci check --base "$BASE_SHA"`, through the words' bin, with `--output <dir>` for a directory of the product's own. */
  command: string;
  /** `BASE_SHA`, as the forge spells it, and the product's own variables (#4964). */
  env: Record<string, string>;
  /** The report directory it writes and hands on. */
  dir: string;
  /** The service containers beside it (#4964). */
  services?: PrCheckService[];
  /** The lines before the command (#4964). */
  before?: string[];
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

/** The variables a check job's own `env` may not set: the ones the job and its handover read, and the credentials it drops. */
const CHECK_RESERVED_ENV = /^(BASE_SHA|HEAD_SHA|CHECK_RESULT|CHANT_RUNNER_KEY|CHANT_RUNNER_IDENTITY|CHANT_LOCAL_EVIDENCE_KEY|CHANT_CHECKOUT_TOKEN|GITHUB_TOKEN|GH_TOKEN|FORGEJO_TOKEN|GITLAB_TOKEN|CI_JOB_TOKEN|CHANT_FORGE_TOKEN|ACTIONS_ID_TOKEN_REQUEST_(URL|TOKEN))$/;

/** Refuse check job settings no job could hold (#4964). */
function assertCheckJobOptions(opts: PrCheckJobOptions): void {
  if (opts.dir !== undefined && (!/^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/.test(opts.dir) || opts.dir.split("/").includes(".."))) {
    throw new Error(`the check job's report directory ${JSON.stringify(opts.dir)} is not a relative path inside the checkout`);
  }
  const names = new Set<string>();
  for (const s of opts.services ?? []) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(s.name)) throw new Error(`the check job's service name ${JSON.stringify(s.name)} is not a host name: lower-case letters, digits, . _ -`);
    if (names.has(s.name)) throw new Error(`the check job names service ${s.name} twice`);
    names.add(s.name);
    if (!s.image.trim() || /\s/.test(s.image)) throw new Error(`the check job's service ${s.name} needs an image reference`);
  }
  for (const name of Object.keys(opts.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`the check job's variable ${JSON.stringify(name)} is not a variable name`);
    if (CHECK_RESERVED_ENV.test(name)) throw new Error(`the check job sets ${name} itself, or drops it before the hooks run, so checkJob.env cannot name it`);
  }
}

/**
 * The check job for `forge` (#4935), with the check evidence job when
 * `evidence` names a runner identity. #4964: the product's services,
 * variables, lines and report directory (`PrCheckJobOptions`), and for a
 * workspace member's GitLab file (`member`) the jobs named
 * `<member>-check` and `<member>-check-evidence`, with the report read from
 * the artifact at the member's `reportPath`, as GitLab includes every
 * member's file in one pipeline. On GitHub and Forgejo a member's workflow
 * is a file of its own, and the jobs keep their names.
 */
export function prCheckJob(forge: ForgeKind, opts: { bin?: string; evidence?: PipelineEvidence; noForks?: boolean; member?: { name: string; reportPath: string } } & PrCheckJobOptions = {}): PrCheckJob {
  assertPipelineEvidence(opts.evidence);
  assertCheckJobOptions(opts);
  const gitlab = forge === "gitlab";
  const base = gitlab ? "$CI_MERGE_REQUEST_DIFF_BASE_SHA" : "${{ github.event.pull_request.base.sha }}";
  const dir = opts.dir ?? PR_CHECK_REPORT_DIR;
  const named = (job: string) => (gitlab && opts.member ? `${opts.member.name}-${job}` : job);
  const job: PrCheckJob = {
    jobName: named(PR_CHECK_JOB),
    command: withProductBin(`chant ci check --base "$BASE_SHA"${dir === PR_CHECK_REPORT_DIR ? "" : ` --output ${dir}`}`, opts.bin),
    env: { BASE_SHA: base, ...opts.env },
    dir,
    ...(opts.services?.length ? { services: opts.services } : {}),
    ...(opts.before?.length ? { before: opts.before } : {}),
  };
  const evidence = opts.evidence;
  if (!evidence) return job;
  const key = evidenceKeyEnv(forge, evidence);
  const bin = opts.bin ? { bin: opts.bin } : {};
  if (gitlab) {
    // #4914: the job runs in the target branch's plan notes pipeline and signs every open merge request's
    // settled check job from its artifact; no job of a merge request pipeline holds the key.
    const out = gitlabOpenEvidenceDir(job.jobName);
    return {
      ...job,
      evidence: {
        jobName: named(PR_CHECK_EVIDENCE_JOB),
        // A fork's check job runs too, as it holds nothing; with noForks (a product plan's forks: "skip") its hooks are not signed for.
        lines: openEvidenceLines({ job: job.jobName, dir: opts.member?.reportPath ?? dir, out, ...bin, ...(opts.noForks ? { noForks: true } : {}) }),
        env: key,
        dir: out,
        ...(evidenceKeyless(evidence) ? { idTokens: evidenceIdTokens(evidence) } : {}),
      },
    };
  }
  return {
    ...job,
    evidence: {
      jobName: PR_CHECK_EVIDENCE_JOB,
      lines: planEvidenceLines({ dir, at: '"$HEAD_SHA"', base: '"$BASE_SHA"', result: '"$CHECK_RESULT"', ...bin }),
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
 *
 * #4964: in a workspace member's GitLab file (`member`) the job is
 * `<member>-ref-gate`. Each member's pipeline decides the whole update
 * against the one rule and sets the one status, so the last job to run
 * after the evidence it needs is in sets success; one that ran before
 * another member's evidence was in set failure, and a re-run settles it.
 * None sets success while a required check lacks evidence.
 */
export function prRefGateJob(forge: ForgeKind, opts: { bin?: string; branch?: string; member?: string } = {}): PrRefGateJob {
  const notes = "'+refs/notes/chant/evidence:refs/notes/chant/evidence'";
  if (forge === "gitlab") {
    return {
      jobName: opts.member ? `${opts.member}-${PR_REF_GATE_JOB}` : PR_REF_GATE_JOB,
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

export { CHECK_JOB_FLOOR, GITLAB_OPEN_EVIDENCE_FLOOR, MEMBER_SIGNED_CHECKS_FLOOR, PR_LOOP_EVIDENCE_FLOOR, PRODUCT_CHECK_JOBS_FLOOR, REF_GATE_STATUS_JOB_FLOOR } from "../release-floors";
