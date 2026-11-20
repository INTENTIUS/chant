/**
 * A delivery pipeline's promote jobs → GitHub Actions workflow (#5324).
 *
 * One workflow, `<pipeline>-promote.yml`, started by hand with the stage and
 * the release. It holds one job per stage after the first, `promote-<stage>`,
 * and the job whose stage matches the input runs
 * `<bin> components promote --to <stage> --release <release>`. The release
 * reaches the command through an environment variable, never through the
 * script text. The job checks out the full history and the workflow asks for
 * `contents: write`, because the promote pushes its records to
 * `chant/lifecycle`. A stage with a cloud identity (#5348) trades the
 * job's OIDC token for it before the checkout, and the stage's config and
 * secret set reaches the promote's step as variables, with the lines that
 * read the stage's store secrets before the command. A stage with
 * `idTokens` (#5427) gets `id-token: write` with or without a trade, and its
 * promote's step holds each token's audience as `<variable>_AUDIENCE` and
 * keeps the token request variables, so its command requests the token
 * itself. The forgejo generator reuses {@link buildGithubPromoteDoc}.
 *
 * With `recheck` (#5326) the workflow also runs on that schedule, and each
 * stage gets a `recheck-<stage>` job, with the same identity, set and
 * environment, that runs `<bin> components promote --to <stage> --pending`:
 * the promotion a soak holds, tried again.
 *
 * With `agentFacts` (#5339) each promote and recheck step also holds
 * `CHANT_AGENT_FACTS=verify-failed` and the relay key, so a failed verify
 * step or a soak check that starts failing records a fact for the
 * verify-failed agent.
 *
 * A stage with agent steps (#5358) gets a job `agent-<stage>` before its
 * promote. It asks for `contents: read` alone, and the job token reaches its
 * checkout step only, which fetches the commit and `chant/lifecycle`. The
 * step that runs `<bin> pipeline agent run` drops every forge token first,
 * holds the model keys alone, and hands its answers on through the job's
 * outputs however it ends. The promote job takes them and runs `<bin>
 * pipeline agent record` before it promotes, so a failed step is recorded
 * with its reason and the promote holds on it. Forgejo's runner ignores
 * `permissions:`; there the dropped tokens keep the step read-only.
 */

import { opWaveBinArgv, opWaveJobTimeout } from "@intentius/chant/op/op-waves";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import { assertEnvironment, CI_IMAGE, environmentDoc, GITHUB_JOB_TOKEN, githubRunsOn, githubSecret, idTokenAudienceEnv, idTokensProblem } from "@intentius/chant/ci-jobs";
import { CHECKOUT_TOKEN_ENV, checkoutScript, dropForgeTokens, handoverOutputs, handoverTrap, takeOverScript } from "@intentius/chant/ci-handover";
import { checkoutStep, concurrency } from "./ci-jobs";
import { OIDC_REQUEST_VARS, TRADE_SPEC_ENV, tradeLine } from "@intentius/chant/ci-identity";
import { emitOpPipelineYAML, type GithubOpPipelineDoc } from "./generate-op-pipeline";
import { opWavesAgentFactsEnv } from "@intentius/chant/ci-agent-triggers";

/** The env var a promote job reads the release from. */
export const PROMOTE_RELEASE_ENV = "CHANT_PROMOTE_RELEASE";

/** The step id the agent job's answers are handed on from (#5358). */
export const AGENT_STEPS_STEP_ID = "chant-agent-steps";

/** Where a stage's agent answers are written and taken back (#5358), `chant pipeline agent`'s default. */
export function agentStepsDir(stage: string): string {
  return `.chant/agent-steps/${stage}`;
}

/** The stage names a promote accepts: lowercase letters, digits, `-` and `_`. */
export const PROMOTE_STAGE_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Check a promote input: at least one stage, each named by lowercase letters, digits, `-` and `_`, once. */
export function assertPipelinePromote(input: PipelinePromoteInput): void {
  const subject = `Pipeline "${input.pipeline}" promote`;
  if (input.stages.length === 0) throw new Error(`${subject} has no stages; a promote needs at least one stage after the first.`);
  const seen = new Set<string>();
  for (const stage of input.stages) {
    if (!PROMOTE_STAGE_NAME.test(stage.name)) {
      throw new Error(`${subject}: stage ${JSON.stringify(stage.name)} is not a valid name; use lowercase letters, digits, "-" and "_".`);
    }
    if (seen.has(stage.name)) throw new Error(`${subject}: stage "${stage.name}" is listed twice.`);
    seen.add(stage.name);
    const tokens = stage.idTokens !== undefined ? idTokensProblem(`stage "${stage.name}" idTokens`, stage.idTokens) : undefined;
    if (tokens) throw new Error(`${subject}: ${tokens}`);
  }
}

/** The workflow document, before emission. */
export function buildGithubPromoteDoc(input: PipelinePromoteInput, dialect: { forge?: "github" | "forgejo" } = {}): GithubOpPipelineDoc {
  assertPipelinePromote(input);
  const forge = dialect.forge ?? "github";
  // #5339: the verify-failed facts' variables, on the command step alone.
  const facts = input.agentFacts ? (opWavesAgentFactsEnv(forge, { ...input.agentFacts, triggers: ["verify-failed"] }) ?? {}) : {};
  const timeout = opWaveJobTimeout(input.jobTimeoutMinutes);
  const bin = opWaveBinArgv(input.bin).join(" ");
  const jobsDoc: Record<string, unknown> = {};
  for (const stage of input.stages) {
    if (stage.environment) assertEnvironment(`${input.pipeline}/${stage.name}`, stage.environment);
    // #5348: the stage's own identity, traded for before the checkout, and its config and secret set.
    const cloud = stage.cloud;
    // #5427: the tokens the promote's command requests itself, with no trade; its step keeps the request variables.
    const idTokens = stage.idTokens;
    const oidc = cloud !== undefined || idTokens !== undefined;
    // #5358: the agent steps' answers are recorded, a failed step with its reason, before the promote reads them.
    const agent = stage.agentSteps;
    const agentJob = `agent-${stage.name}`;
    const dir = agentStepsDir(stage.name);
    const job = (condition: string, step: string, command: string, own: Record<string, string>, answers = false) => ({
      ...(answers ? { needs: agentJob } : {}),
      if: condition,
      "runs-on": githubRunsOn(input.runner),
      ...(stage.environment ? { environment: environmentDoc(stage.environment) } : {}),
      ...(oidc ? { permissions: { contents: "write", "id-token": "write" } } : {}),
      "timeout-minutes": timeout.minutes,
      container: CI_IMAGE,
      concurrency: concurrency(`${input.pipeline}-promote-${stage.name}`, false),
      steps: [
        ...(cloud ? [{ name: "Trade the job's OIDC token for the stage's cloud identity", env: { [TRADE_SPEC_ENV]: JSON.stringify(cloud) }, run: tradeLine("$GITHUB_ENV", "github-env") }] : []),
        checkoutStep(true),
        ...(answers ? [{ name: `Take the answers of ${stage.name}'s agent steps`, run: takeOverScript(agentJob, dir, forge) }] : []),
        { name: step, ...(Object.keys({ ...stage.variables, ...own, ...facts, ...idTokenAudienceEnv(idTokens) }).length > 0 ? { env: { ...(stage.variables ?? {}), ...idTokenAudienceEnv(idTokens), ...own, ...facts } } : {}), run: [...(cloud && !idTokens ? [`unset ${OIDC_REQUEST_VARS.join(" ")}`] : []), ...(stage.setup ?? []), command].join("\n") },
      ],
    });
    if (agent) {
      jobsDoc[agentJob] = {
        if: `\${{ inputs.stage == '${stage.name}' }}`,
        "runs-on": githubRunsOn(input.runner),
        permissions: { contents: "read" },
        "timeout-minutes": timeout.minutes,
        container: CI_IMAGE,
        outputs: handoverOutputs(AGENT_STEPS_STEP_ID, forge),
        steps: [
          { name: "Check out the commit and the ledger", env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN }, run: checkoutScript(true, true) },
          {
            id: AGENT_STEPS_STEP_ID,
            name: `Run the agent steps of ${stage.name}`,
            // The model keys alone: every forge token is dropped before the command starts.
            env: { ...Object.fromEntries(agent.keyEnvs.map((k) => [k, githubSecret(k)])), [PROMOTE_RELEASE_ENV]: "${{ inputs.release }}" },
            run: [dropForgeTokens("sh"), ...handoverTrap(dir, forge, { label: "chant-agent-steps" }), `${bin} pipeline agent run --stage ${stage.name} --release "$${PROMOTE_RELEASE_ENV}" --output ${dir}`].join("\n"),
          },
        ],
      };
    }
    const promote = `${bin} components promote --to ${stage.name} --release "$${PROMOTE_RELEASE_ENV}"`;
    jobsDoc[`promote-${stage.name}`] = agent
      ? // With agent steps, the promote runs when a step failed too, so it records why and holds.
        job(
          `\${{ !cancelled() && inputs.stage == '${stage.name}' }}`,
          `Promote the release into ${stage.name}`,
          [`${bin} pipeline agent record --stage ${stage.name} --release "$${PROMOTE_RELEASE_ENV}" --from ${dir}`, promote].join("\n"),
          { [PROMOTE_RELEASE_ENV]: "${{ inputs.release }}" },
          true,
        )
      : job(`\${{ inputs.stage == '${stage.name}' }}`, `Promote the release into ${stage.name}`, promote, { [PROMOTE_RELEASE_ENV]: "${{ inputs.release }}" });
    // #5326: the promotion a soak holds, tried again on the schedule. It shares the stage's concurrency group, so it never runs beside a promote.
    if (input.recheck) {
      jobsDoc[`recheck-${stage.name}`] = job("${{ github.event_name == 'schedule' }}", `Promote the release a soak holds into ${stage.name}`, `${bin} components promote --to ${stage.name} --pending`, {});
    }
  }
  return {
    name: `${input.pipeline} promote`,
    on: {
      ...(input.recheck ? { schedule: [{ cron: input.recheck.schedule }] } : {}),
      workflow_dispatch: {
        inputs: {
          stage: { description: "The stage the release is promoted into", required: true, type: "choice", options: input.stages.map((s) => s.name) },
          release: { description: "The release's label or digest", required: true, type: "string" },
        },
      },
    },
    permissions: { contents: "write" },
    jobsDoc,
  };
}

/** Render a pipeline's promote jobs as one GitHub Actions workflow, `<pipeline>-promote.yml`. */
export function generateGithubPipelinePromote(input: PipelinePromoteInput): Array<{ name: string; yaml: string }> {
  return [{ name: `${input.pipeline}-promote.yml`, yaml: emitOpPipelineYAML(buildGithubPromoteDoc(input)) }];
}
