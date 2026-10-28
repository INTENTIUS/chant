/**
 * The agent jobs on GitLab (#4616): `ScheduledOpSpec.agent`. What each job
 * does is @intentius/chant/ci-agent's; this file lays them out in GitLab's
 * terms.
 *
 * GitLab starts no pipeline on a note, and every job in a pipeline gets the
 * same protected variables. So:
 *
 * - a comment agent runs in a pipeline of the default branch that the API, a
 *   trigger or a person starts with `CHANT_AGENT_PR` (the merge request's
 *   iid) and `CHANT_AGENT_ASK` (the ask). Whoever starts that pipeline is
 *   who asked. A drift agent follows the drift Op's job in its scheduled
 *   pipeline and runs when that job's run exited with chant's `drift` code.
 * - the agent job unsets every forge token variable and drops the job token
 *   from the remote before the model runs, and keeps the agent directory as
 *   an artifact. It holds the model's key.
 * - the push job runs in the same pipeline under environment
 *   `<agent>-push`, takes the artifact, and pushes with `tokenEnv`
 *   (`CHANT_FORGE_TOKEN` by default). Scope that variable to the
 *   `<agent>-push` environment, protected and masked, so the agent job never
 *   holds it.
 *
 * A workspace member's drift Op runs in the member's directory, so its
 * artifact holds `<member>/.chant/agent` (#4619). Both agent jobs run at
 * the repository root and take `dir`, that path, as their agent directory.
 */

import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { gitlabTags, type CiRunner } from "@intentius/chant/ci-jobs";
import {
  AGENT_DECISION_FILE,
  AGENT_DIR,
  AGENT_DRIFT_FILE,
  AGENT_GITLAB_TOKEN_ENV,
  AGENT_HEAD_REF,
  agentCommandLines,
  agentGitAuthLines,
  agentHeadFetchLine,
  agentSettingsEnv,
  GITLAB_AGENT_ASK_VAR,
  GITLAB_AGENT_PR_VAR,
  type AgentSettings,
} from "@intentius/chant/ci-agent";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";

/** The dotenv the drift Op's job leaves, which says whether it found drift. */
const DRIFT_DOTENV = `${AGENT_DIR}/drift.env`;
const AGENT_ARTIFACT_EXPIRY = "7 days";

/** The comment agent's rule: a pipeline of the default branch started with the merge request and the ask. */
export const GITLAB_AGENT_RULE = `$CI_PIPELINE_SOURCE =~ /^(web|api|trigger|chat)$/ && $${GITLAB_AGENT_PR_VAR} =~ /^[0-9]+$/ && $${GITLAB_AGENT_ASK_VAR} && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH`;

export function gitlabAgentPushJobName(jobName: string): string {
  return `${jobName}-push`;
}

/** The environment the push job runs under, which the push token is scoped to. */
export function gitlabAgentEnvironment(jobName: string): string {
  return `${jobName}-push`;
}

/** The remote without the job token GitLab put in its URL. */
const PLAIN_REMOTE = 'git remote set-url origin "$CI_SERVER_URL/$CI_PROJECT_PATH.git"';
/** The ledger branch, for the run count and the record. */
const LEDGER_FETCH = "git fetch -q --no-tags origin '+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle' 2>/dev/null || true";

/**
 * The drift Op's script lines (#4616): the run with its output kept for the
 * agent, and `CHANT_AGENT_DRIFT=1` in a dotenv when it exits with chant's
 * `drift` code. The job still exits with the run's code.
 */
export function gitlabDriftRunLines(invocation: string): string[] {
  return [
    `mkdir -p ${AGENT_DIR}`,
    `set +e; { ${invocation}; echo "$?" > ${AGENT_DIR}/code; } 2>&1 | tee ${AGENT_DIR}/${AGENT_DRIFT_FILE}; code=$(cat ${AGENT_DIR}/code); set -e`,
    `if [ "$code" -eq ${CHANT_EXIT.drift} ]; then echo "CHANT_AGENT_DRIFT=1" > ${DRIFT_DOTENV}; else echo "CHANT_AGENT_DRIFT=0" > ${DRIFT_DOTENV}; fi`,
    'exit "$code"',
  ];
}

/** The drift Op job's artifacts: the output for the agent and the dotenv. */
export function gitlabDriftArtifacts(dir: string): Record<string, unknown> {
  return { when: "always", paths: [dir], reports: { dotenv: `${dir}/drift.env` }, expire_in: AGENT_ARTIFACT_EXPIRY };
}

export interface GitlabAgentJobsInput {
  jobName: string;
  stage: string;
  image: string;
  settings: AgentSettings;
  runner?: CiRunner;
  /** Setup and before-script lines, run before chant in both jobs. */
  script: readonly string[];
  /** The variable holding the push token. Default {@link AGENT_GITLAB_TOKEN_ENV}. */
  tokenEnv?: string;
  bin?: string;
  /** For a drift agent: the Op's job and its rules. */
  after?: { job: string; rules: unknown[] };
  /** The agent directory from the repository root: where the drift Op's artifact put the drift. Default {@link AGENT_DIR}. */
  dir?: string;
}

/** The agent job and the push job. */
export function gitlabAgentJobs(i: GitlabAgentJobsInput): { agent: Record<string, unknown>; push: Record<string, unknown> } {
  const s = i.settings;
  const dir = i.dir ?? AGENT_DIR;
  const lines = agentCommandLines("gitlab", i.bin, dir);
  const comment = s.on === "comment";
  const tags = gitlabTags(i.runner);
  const variables = { ...agentSettingsEnv(s), GIT_DEPTH: "0" };
  const rules = comment ? [{ if: GITLAB_AGENT_RULE }] : i.after!.rules.map((r) => ({ ...(r as Record<string, unknown>), when: "always" }));
  const head = comment ? [agentHeadFetchLine("gitlab", GITLAB_AGENT_PR_VAR)] : [];
  // A drift agent's job runs whatever the drift check found, and stops here when it found none.
  const driftGate = comment ? [] : [`if [ "\${CHANT_AGENT_DRIFT:-0}" != "1" ]; then echo "no drift, so the agent does not run"; exit 0; fi`];
  const agent: Record<string, unknown> = {
    stage: i.stage,
    image: i.image,
    ...(tags ? { tags } : {}),
    resource_group: i.jobName,
    timeout: `${s.timeout + 15} minutes`,
    variables,
    rules,
    ...(comment ? {} : { needs: [{ job: i.after!.job, artifacts: true }] }),
    script: [
      ...driftGate,
      ...head,
      LEDGER_FETCH,
      PLAIN_REMOTE,
      ...i.script,
      // No forge token reaches the model: the decision needs none on GitLab, and the push job checks the merge request.
      GITLAB_DROP_FORGE_TOKENS,
      lines.prepare,
      lines.run,
    ],
    artifacts: { when: "always", paths: [dir], expire_in: AGENT_ARTIFACT_EXPIRY },
  };
  const tokenVar = i.tokenEnv ?? AGENT_GITLAB_TOKEN_ENV;
  const push: Record<string, unknown> = {
    stage: i.stage,
    image: i.image,
    ...(tags ? { tags } : {}),
    resource_group: gitlabAgentPushJobName(i.jobName),
    environment: { name: gitlabAgentEnvironment(i.jobName), action: "access" },
    variables,
    rules,
    needs: [{ job: i.jobName, artifacts: true }],
    script: [
      // The agent job leaves a decision whenever it ran; with none, the drift check found nothing.
      ...(comment ? [] : [`if [ ! -f ${dir}/${AGENT_DECISION_FILE} ]; then echo "the agent did not run"; exit 0; fi`]),
      ...head,
      LEDGER_FETCH,
      PLAIN_REMOTE,
      ...i.script,
      `export CHANT_GITLAB_TOKEN="$${tokenVar}"`,
      ...agentGitAuthLines(tokenVar, "oauth2"),
      lines.land,
    ],
  };
  return { agent, push };
}

/** The header lines a file with agent jobs carries: how to start a comment agent and where the token goes. */
export function gitlabAgentHeader(jobName: string, s: AgentSettings, tokenVar = AGENT_GITLAB_TOKEN_ENV): string[] {
  return [
    comment(s)
      ? `#   ${jobName}: answers ${s.comment} from a pipeline of the default branch started with ${GITLAB_AGENT_PR_VAR}=<iid> and ${GITLAB_AGENT_ASK_VAR}=<ask>`
      : `#   ${jobName}: after the drift check exits ${CHANT_EXIT.drift}, opens or updates a merge request from ${s.branch}`,
    `#     ${gitlabAgentPushJobName(jobName)} pushes with ${tokenVar}: scope it to environment ${gitlabAgentEnvironment(jobName)}, protected and masked; the model's key is ${s.keyEnv}`,
    `#     the fetched head is ${AGENT_HEAD_REF}; runs are limited to ${s.maxRuns ?? "no fixed number of"} a day on the ledger` +
      (s.maxCostUsd !== undefined ? `, and to $${s.maxCostUsd} a day of recorded cost` : ""),
  ];
}

function comment(s: AgentSettings): boolean {
  return s.on === "comment";
}
