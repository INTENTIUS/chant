/**
 * The agent jobs on GitHub and Forgejo (#4616): `ScheduledOpSpec.agent`.
 * What each job does is @intentius/chant/ci-agent's; this file lays them
 * out so the model never shares a job with a write token:
 *
 * - the agent job holds `contents: read` and `pull-requests: read`. Its
 *   checkout script alone sees the job token, for the fetches (the target
 *   branch's commit, chant/lifecycle for the run count, and for a comment
 *   the pull request's head). `chant agent prepare` reads with the job
 *   token; `chant agent run` is the last step and starts without any forge
 *   token, with the model's key from its secret, and hands the agent
 *   directory on as the job's outputs (`handoverTrap`).
 * - the push job checks out the target branch's commit, takes the agent
 *   directory back as data and runs `chant agent land` with the push token:
 *   `tokenEnv`'s secret, else the job token. A push made with the job token
 *   starts no workflow on GitHub, so the pull request is planned again only
 *   with a token of a user or an app.
 *
 * Forgejo's runner ignores `permissions:` and has no author association, so
 * there `chant agent prepare` asks the forge whether the commenter can write,
 * and both jobs drop the token variables before any step that does not need
 * them.
 */

import { CHECKOUT_TOKEN_ENV, checkoutScript, dropForgeTokens, handoverOutputs, handoverTrap, takeOverScript } from "@intentius/chant/ci-handover";
import { githubRunsOn, GITHUB_JOB_TOKEN, githubSecret, githubSecretOrJobToken, type CiRunner } from "@intentius/chant/ci-jobs";
import {
  AGENT_DECISION_FILE,
  AGENT_DIR,
  AGENT_DRIFT_FILE,
  AGENT_PATCH_FILE,
  AGENT_RC_FILE,
  agentCommandLines,
  agentGitAuthLines,
  agentHeadFetchLine,
  agentSettingsEnv,
  type AgentSettings,
} from "@intentius/chant/ci-agent";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";

/** The agent step's id, which the agent job's outputs come from. */
export const AGENT_STEP_ID = "chant-agent";
/** The drift Op's run step id, whose outputs carry the drift and the code. */
export const AGENT_DRIFT_STEP_ID = "chant-run";
/** The variable the push step holds its token in, for git's header and the forge client. */
const PUSH_TOKEN_ENV = "CHANT_AGENT_TOKEN";

/** The files the handover keeps when the agent directory is too large to hand on whole. */
const HANDED = { label: "chant-agent", noteFiles: [AGENT_DECISION_FILE, AGENT_RC_FILE, AGENT_PATCH_FILE, "prompt.sha256"] } as const;
const DRIFT_HANDED = { label: "chant-agent", noteFiles: [AGENT_DRIFT_FILE] } as const;

/** The name of the push job beside the agent job. */
export function agentPushJobName(jobName: string): string {
  return `${jobName}-push`;
}

/** The agent job's name for a drift Op's job. */
export function agentJobName(jobName: string, on: AgentSettings["on"]): string {
  return on === "drift" ? `${jobName}-agent` : jobName;
}

export interface GithubAgentJobsInput {
  forge: "github" | "forgejo";
  /** The agent job's name. */
  jobName: string;
  image: string;
  settings: AgentSettings;
  runner?: CiRunner;
  /** Setup steps, as built by `setupStepDoc`. */
  setup: Array<Record<string, unknown>>;
  beforeScript: readonly string[];
  /** The secret holding the push token; absent: the job token. */
  tokenEnv?: string;
  /** The command in place of `chant`: the product's bin. */
  bin?: string;
  /** For a drift agent: the Op's job, which handed the drift on. */
  after?: string;
}

/** The comment condition of the agent job: a pull request comment that starts with the agent's line, from a writer on GitHub. */
export function agentCommentIf(forge: "github" | "forgejo", comment: string): string {
  return [
    "github.event_name == 'issue_comment'",
    forge === "forgejo" ? "(github.event.issue.pull_request || github.event.is_pull)" : "github.event.issue.pull_request",
    `startsWith(github.event.comment.body, '${comment.replace(/'/g, "''")} ')`,
    ...(forge === "forgejo" ? [] : ["contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.comment.author_association)"]),
  ].join(" && ");
}

/**
 * The drift Op's run step (#4616): the run with its output kept as the
 * drift for the agent, `drift=true` among the step's outputs when it exits
 * with chant's `drift` code, and the output handed on. The step still exits
 * with the run's code.
 */
export function driftRunStep(invocation: string, env: Record<string, string>, forge: "github" | "forgejo"): Record<string, unknown> {
  return {
    id: AGENT_DRIFT_STEP_ID,
    env,
    run: [
      "set +e",
      `mkdir -p ${AGENT_DIR}`,
      ...handoverTrap(AGENT_DIR, forge, DRIFT_HANDED),
      `{ ${invocation}; echo "$?" >"\${RUNNER_TEMP:-/tmp}/chant-run.code"; } 2>&1 | tee ${AGENT_DIR}/${AGENT_DRIFT_FILE}`,
      'code=$(cat "${RUNNER_TEMP:-/tmp}/chant-run.code")',
      `if [ "$code" -eq ${CHANT_EXIT.drift} ]; then echo "drift=true" >>"$GITHUB_OUTPUT"; fi`,
      'exit "$code"',
    ].join("\n"),
  };
}

/** The drift Op job's outputs: the handed-on drift and the drift flag. */
export function driftRunOutputs(forge: "github" | "forgejo"): Record<string, string> {
  return { ...handoverOutputs(AGENT_DRIFT_STEP_ID, forge), drift: `\${{ steps.${AGENT_DRIFT_STEP_ID}.outputs.drift }}` };
}

/** The agent job and the push job. */
export function githubAgentJobs(i: GithubAgentJobsInput): { agent: Record<string, unknown>; push: Record<string, unknown> } {
  const s = i.settings;
  const lines = agentCommandLines(i.forge, i.bin);
  const drop = dropForgeTokens("sh");
  const comment = s.on === "comment";
  const settingsEnv = agentSettingsEnv(s);
  const checkout = (head: boolean): Record<string, unknown> => ({
    name: head ? "Check out the target branch's commit and the pull request's head" : "Check out the commit the drift check ran on",
    env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN, ...(head ? { PR_NUMBER: "${{ github.event.issue.number }}" } : {}) },
    // The ledger branch too: prepare counts the agent's runs on it, and land appends to it.
    run: [checkoutScript(true, true), ...(head ? [agentHeadFetchLine(i.forge, "PR_NUMBER")] : [])].join("\n"),
  });
  const before = i.beforeScript.map((line) => ({ run: `${drop}\n${line}` }));
  const timeout = s.timeout + 15;
  const agent: Record<string, unknown> = {
    ...(comment ? { if: agentCommentIf(i.forge, s.comment!) } : { needs: i.after, if: `always() && needs.${i.after}.outputs.drift == 'true'` }),
    "runs-on": githubRunsOn(i.runner),
    container: i.image,
    "timeout-minutes": timeout,
    permissions: { contents: "read", "pull-requests": "read" },
    env: settingsEnv,
    outputs: handoverOutputs(AGENT_STEP_ID, i.forge),
    steps: [
      checkout(comment),
      ...(comment ? [] : [{ name: "Take the drift from the drift check", run: takeOverScript(i.after!, AGENT_DIR, i.forge) }]),
      ...i.setup,
      ...before,
      // Reads only: the comment, the commenter's access, the pull request's head and the ledger.
      { name: "Decide whether the agent runs", env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN }, run: lines.prepare },
      // The job's last step: the model's key and no forge token, and the agent directory handed on however it ends.
      {
        id: AGENT_STEP_ID,
        name: "Run the agent",
        env: { [s.keyEnv]: githubSecret(s.keyEnv) },
        run: [drop, ...handoverTrap(AGENT_DIR, i.forge, HANDED), lines.run].join("\n"),
      },
    ],
  };
  const token = i.tokenEnv ? githubSecretOrJobToken(i.tokenEnv) : GITHUB_JOB_TOKEN;
  const push: Record<string, unknown> = {
    needs: i.jobName,
    if: `always() && needs.${i.jobName}.result == 'success'`,
    "runs-on": githubRunsOn(i.runner),
    container: i.image,
    permissions: { contents: "write", "pull-requests": "write", issues: "write" },
    env: settingsEnv,
    steps: [
      checkout(comment),
      { name: "Take the change from the agent job", run: takeOverScript(i.jobName, AGENT_DIR, i.forge) },
      ...i.setup,
      ...before,
      {
        name: comment ? "Push the change to the pull request" : "Open or update the agent's pull request",
        env: { [PUSH_TOKEN_ENV]: token, GITHUB_TOKEN: token, ...(i.forge === "forgejo" ? { CHANT_FORGEJO_TOKEN: token } : {}) },
        run: [...agentGitAuthLines(PUSH_TOKEN_ENV, "x-access-token"), lines.land].join("\n"),
      },
    ],
  };
  return { agent, push };
}
