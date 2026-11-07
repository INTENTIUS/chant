/**
 * The commit jobs on GitLab (#4722): `ScheduledOpSpec.commit`. What each job
 * does is @intentius/chant/ci-commit's; this file lays them out as the
 * agent's are laid out (./agent-jobs.ts):
 *
 * - a comment commit job runs in a pipeline of the default branch that the
 *   API, a trigger or a person starts with `CHANT_COMMIT_PR` (the merge
 *   request's iid) and `CHANT_COMMIT` (the command's word). Whoever starts
 *   that pipeline is who asked.
 * - a check commit job follows the Op's job in the merge request pipeline
 *   and runs when its run exits with one of the spec's finding codes. It is
 *   off unless the spec sets `gitlabCheck`: the push token is a protected
 *   variable, which a merge request pipeline of an unprotected branch does
 *   not get.
 * - the commit job unsets every forge token variable before the command
 *   runs and keeps the commit directory as an artifact. The push job runs
 *   under environment `<job>-push` and pushes with `tokenEnv`
 *   (`CHANT_FORGE_TOKEN` by default), which is scoped to that environment.
 */

import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { gitlabTags, type CiRunner } from "@intentius/chant/ci-jobs";
import { agentGitAuthLines, agentHeadFetchLine } from "@intentius/chant/ci-agent";
import {
  COMMIT_DECISION_FILE,
  COMMIT_DIR,
  COMMIT_GITLAB_TOKEN_ENV,
  COMMIT_HEAD_REF,
  commitCommandLines,
  commitSettingsEnv,
  GITLAB_COMMIT_PR_VAR,
  GITLAB_COMMIT_WORD_VAR,
  type CommitSettings,
} from "@intentius/chant/ci-commit";

const COMMIT_ARTIFACT_EXPIRY = "7 days";
/** The dotenv the check's job leaves, which says whether it found something. */
const FINDING_DOTENV = `${COMMIT_DIR}/finding.env`;

export function gitlabCommitPushJobName(jobName: string): string {
  return `${jobName}-push`;
}

/** The environment the push job runs under, which the push token is scoped to. */
export function gitlabCommitEnvironment(jobName: string): string {
  return `${jobName}-push`;
}

/** The comment commit job's rule: a pipeline of the default branch started with the merge request and the command's word. */
export function gitlabCommitRule(s: Pick<CommitSettings, "comment">): string {
  const word = s.comment!.split(" ")[1];
  return `$CI_PIPELINE_SOURCE =~ /^(web|api|trigger|chat)$/ && $${GITLAB_COMMIT_PR_VAR} =~ /^[0-9]+$/ && $${GITLAB_COMMIT_WORD_VAR} == "${word}" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH`;
}

/** The check's script lines (#4722): `CHANT_COMMIT_FINDING=1` in a dotenv when the run exits with one of `findings`. The job still exits with the run's code. */
export function gitlabFindingRunLines(invocation: string, findings: readonly number[]): string[] {
  const codes = findings.map((c) => `[ "$code" -eq ${c} ]`).join(" || ");
  return [
    `mkdir -p ${COMMIT_DIR}`,
    `set +e; ${invocation}; code=$?; set -e`,
    `if ${codes}; then echo "CHANT_COMMIT_FINDING=1" > ${FINDING_DOTENV}; else echo "CHANT_COMMIT_FINDING=0" > ${FINDING_DOTENV}; fi`,
    'exit "$code"',
  ];
}

/** The check job's artifacts: the dotenv. */
export function gitlabFindingArtifacts(dir: string = COMMIT_DIR): Record<string, unknown> {
  return { when: "always", paths: [`${dir}/finding.env`], reports: { dotenv: `${dir}/finding.env` }, expire_in: COMMIT_ARTIFACT_EXPIRY };
}

/** The remote without the job token GitLab put in its URL. */
const PLAIN_REMOTE = 'git remote set-url origin "$CI_SERVER_URL/$CI_PROJECT_PATH.git"';
/** The ledger branch, for the run count, the approvals and the record. */
const LEDGER_FETCH = "git fetch -q --no-tags origin '+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle' 2>/dev/null || true";

export interface GitlabCommitJobsInput {
  jobName: string;
  stage: string;
  image: string;
  settings: CommitSettings;
  runner?: CiRunner;
  /** Setup and before-script lines, run before chant in both jobs. */
  script: readonly string[];
  /** The variable holding the push token. Default {@link COMMIT_GITLAB_TOKEN_ENV}. */
  tokenEnv?: string;
  bin?: string;
  /** For `check`: the Op's job and its rules. */
  after?: { job: string; rules: unknown[] };
}

/** The commit job and the push job. */
export function gitlabCommitJobs(i: GitlabCommitJobsInput): { commit: Record<string, unknown>; push: Record<string, unknown> } {
  const s = i.settings;
  const lines = commitCommandLines("gitlab", i.bin);
  const comment = s.on === "comment";
  const tags = gitlabTags(i.runner);
  const variables = { ...commitSettingsEnv(s), GIT_DEPTH: "0" };
  const rules = comment ? [{ if: gitlabCommitRule(s) }] : i.after!.rules.map((r) => ({ ...(r as Record<string, unknown>), when: "always" }));
  const head = [agentHeadFetchLine("gitlab", comment ? GITLAB_COMMIT_PR_VAR : "CI_MERGE_REQUEST_IID", COMMIT_HEAD_REF)];
  const findingGate = comment ? [] : [`if [ "\${CHANT_COMMIT_FINDING:-0}" != "1" ]; then echo "the check found nothing, so ${s.name} does not run"; exit 0; fi`];
  const commit: Record<string, unknown> = {
    stage: i.stage,
    image: i.image,
    ...(tags ? { tags } : {}),
    resource_group: i.jobName,
    timeout: `${s.timeout + 15} minutes`,
    variables,
    rules,
    ...(comment ? {} : { needs: [{ job: i.after!.job, artifacts: true }] }),
    script: [
      ...findingGate,
      ...head,
      LEDGER_FETCH,
      PLAIN_REMOTE,
      ...i.script,
      // No forge token reaches the command: the decision needs none on GitLab, and the push job checks the merge request.
      GITLAB_DROP_FORGE_TOKENS,
      lines.prepare,
      lines.run,
    ],
    artifacts: { when: "always", paths: [COMMIT_DIR], expire_in: COMMIT_ARTIFACT_EXPIRY },
  };
  const tokenVar = i.tokenEnv ?? COMMIT_GITLAB_TOKEN_ENV;
  const push: Record<string, unknown> = {
    stage: i.stage,
    image: i.image,
    ...(tags ? { tags } : {}),
    resource_group: gitlabCommitPushJobName(i.jobName),
    environment: { name: gitlabCommitEnvironment(i.jobName), action: "access" },
    variables,
    rules,
    needs: [{ job: i.jobName, artifacts: true }],
    script: [
      `if [ ! -f ${COMMIT_DIR}/${COMMIT_DECISION_FILE} ]; then echo "${s.name} did not run"; exit 0; fi`,
      ...head,
      LEDGER_FETCH,
      PLAIN_REMOTE,
      ...i.script,
      `export CHANT_GITLAB_TOKEN="$${tokenVar}"`,
      ...agentGitAuthLines(tokenVar, "oauth2"),
      lines.land,
    ],
  };
  return { commit, push };
}

/** The header lines a file with commit jobs carries: how a comment job is started and where the token goes. */
export function gitlabCommitHeader(jobName: string, s: CommitSettings, tokenVar = COMMIT_GITLAB_TOKEN_ENV): string[] {
  return [
    s.on === "comment"
      ? `#   ${jobName}: answers ${s.comment} from a pipeline of the default branch started with ${GITLAB_COMMIT_PR_VAR}=<iid> and ${GITLAB_COMMIT_WORD_VAR}=${s.comment!.split(" ")[1]}`
      : `#   ${jobName}: after the check exits ${s.findings.join(" or ")} on a merge request, runs ${s.command.join(" ")} and pushes its change`,
    `#     ${gitlabCommitPushJobName(jobName)} pushes with ${tokenVar}: scope it to environment ${gitlabCommitEnvironment(jobName)}, protected and masked`,
    `#     the change may touch ${s.allowed.join(", ")}; at most ${s.maxRuns} commits per merge request, counted on the ledger`,
  ];
}
