/**
 * The commit jobs on GitHub and Forgejo (#4722): `ScheduledOpSpec.commit`.
 * What each job does is @intentius/chant/ci-commit's; this file lays them
 * out as the agent's jobs are laid out (./agent-jobs.ts):
 *
 * - the commit job holds `contents: read` and `pull-requests: read`. Its
 *   checkout script alone sees the job token, for the fetches (the target
 *   branch's commit, chant/lifecycle, and the pull request's head).
 *   `chant commit prepare` reads with the job token; `chant commit run` is
 *   the last step, starts without any forge token, and hands the commit
 *   directory on as the job's outputs.
 * - the push job runs `chant commit land` with `tokenEnv`'s secret, which is
 *   required: a push made with the job token starts no workflow, so the new
 *   head would get no plan.
 *
 * On `comment` the jobs are a workflow of their own on pull request
 * comments. On `check` they follow the Op's own job on the pull request and
 * run when its run exits with one of the spec's finding codes.
 */

import { CHECKOUT_TOKEN_ENV, checkoutScript, dropForgeTokens, handoverOutputs, handoverTrap, takeOverScript } from "@intentius/chant/ci-handover";
import { githubRunsOn, GITHUB_JOB_TOKEN, githubSecret, type CiRunner } from "@intentius/chant/ci-jobs";
import { agentGitAuthLines, agentHeadFetchLine } from "@intentius/chant/ci-agent";
import { COMMIT_DECISION_FILE, COMMIT_DIR, COMMIT_HEAD_REF, COMMIT_PATCH_FILE, COMMIT_RC_FILE, commitCommandLines, commitSettingsEnv, type CommitSettings } from "@intentius/chant/ci-commit";
import { agentCommentIf } from "./agent-jobs";

/** The commit step's id, which the commit job's outputs come from. */
export const COMMIT_STEP_ID = "chant-commit";
/** The check's run step id, whose `finding` output starts the commit jobs. */
export const COMMIT_FINDING_STEP_ID = "chant-check";
/** The variable the push step holds its token in, for git's header and the forge client. */
const PUSH_TOKEN_ENV = "CHANT_COMMIT_TOKEN";

const HANDED = { label: "chant-commit", noteFiles: [COMMIT_DECISION_FILE, COMMIT_RC_FILE, COMMIT_PATCH_FILE] } as const;

/** The commit job's name: the spec's job on a comment, `<job>-commit` after a check. */
export function commitJobName(jobName: string, on: CommitSettings["on"]): string {
  return on === "check" ? `${jobName}-commit` : jobName;
}

/** The name of the push job beside the commit job. */
export function commitPushJobName(jobName: string): string {
  return `${jobName}-push`;
}

/**
 * The check's run step (#4722): `finding=true` among the step's outputs when
 * the run exits with one of `findings`. The step still exits with the run's
 * code, so the check stays red.
 */
export function findingRunStep(invocation: string, env: Record<string, string>, findings: readonly number[]): Record<string, unknown> {
  const codes = findings.map((c) => `"$code" -eq ${c}`).join(" ] || [ ");
  return {
    id: COMMIT_FINDING_STEP_ID,
    env,
    run: ["set +e", invocation, "code=$?", `if [ ${codes} ]; then echo "finding=true" >>"$GITHUB_OUTPUT"; fi`, 'exit "$code"'].join("\n"),
  };
}

/** The check job's outputs: the finding flag. */
export function findingRunOutputs(): Record<string, string> {
  return { finding: `\${{ steps.${COMMIT_FINDING_STEP_ID}.outputs.finding }}` };
}

export interface GithubCommitJobsInput {
  forge: "github" | "forgejo";
  /** The commit job's name. */
  jobName: string;
  image: string;
  settings: CommitSettings;
  runner?: CiRunner;
  setup: Array<Record<string, unknown>>;
  beforeScript: readonly string[];
  /** The secret holding the push token. */
  tokenEnv: string;
  bin?: string;
  /** For `check`: the Op's job, which ran the check. */
  after?: string;
}

/** The commit job and the push job. */
export function githubCommitJobs(i: GithubCommitJobsInput): { commit: Record<string, unknown>; push: Record<string, unknown> } {
  const s = i.settings;
  const lines = commitCommandLines(i.forge, i.bin);
  const drop = dropForgeTokens("sh");
  const comment = s.on === "comment";
  const prNumber = comment ? "${{ github.event.issue.number }}" : "${{ github.event.pull_request.number }}";
  const settingsEnv = commitSettingsEnv(s);
  const checkout: Record<string, unknown> = {
    name: "Check out the target branch's commit and the pull request's head",
    env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN, PR_NUMBER: prNumber },
    run: [checkoutScript(true, true), agentHeadFetchLine(i.forge, "PR_NUMBER", COMMIT_HEAD_REF)].join("\n"),
  };
  const before = i.beforeScript.map((line) => ({ run: `${drop}\n${line}` }));
  const commit: Record<string, unknown> = {
    ...(comment ? { if: agentCommentIf(i.forge, s.comment!, true) } : { needs: i.after, if: `always() && needs.${i.after}.outputs.finding == 'true'` }),
    "runs-on": githubRunsOn(i.runner),
    container: i.image,
    "timeout-minutes": s.timeout + 15,
    permissions: { contents: "read", "pull-requests": "read" },
    env: settingsEnv,
    outputs: handoverOutputs(COMMIT_STEP_ID, i.forge),
    steps: [
      checkout,
      ...i.setup,
      ...before,
      { name: "Decide whether the command runs", env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN }, run: lines.prepare },
      // The job's last step: no forge token, and the commit directory handed on however it ends.
      { id: COMMIT_STEP_ID, name: "Run the command", run: [drop, ...handoverTrap(COMMIT_DIR, i.forge, HANDED), lines.run].join("\n") },
    ],
  };
  const token = githubSecret(i.tokenEnv);
  const push: Record<string, unknown> = {
    needs: i.jobName,
    if: `always() && needs.${i.jobName}.result == 'success'`,
    "runs-on": githubRunsOn(i.runner),
    container: i.image,
    permissions: { contents: "write", "pull-requests": "write", issues: "write" },
    env: settingsEnv,
    steps: [
      checkout,
      { name: "Take the change from the commit job", run: takeOverScript(i.jobName, COMMIT_DIR, i.forge) },
      ...i.setup,
      ...before,
      {
        name: "Push the change to the pull request",
        env: { [PUSH_TOKEN_ENV]: token, GITHUB_TOKEN: token, ...(i.forge === "forgejo" ? { CHANT_FORGEJO_TOKEN: token } : {}) },
        run: [...agentGitAuthLines(PUSH_TOKEN_ENV, "x-access-token"), lines.land].join("\n"),
      },
    ],
  };
  return { commit, push };
}
