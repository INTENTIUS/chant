/**
 * A delivery pipeline's promote jobs → GitLab CI file (#5324).
 *
 * One file, `<pipeline>-promote.gitlab-ci.yml`, with a job `promote-<stage>`
 * per stage after the first. A person starts a pipeline from the web with
 * `CHANT_PROMOTE_STAGE` and `CHANT_PROMOTE_RELEASE` set, and the job whose
 * stage matches runs `<bin> components promote --to <stage> --release
 * "$CHANT_PROMOTE_RELEASE"`. Each job fetches the full history and runs one
 * at a time per stage through its resource group.
 *
 * With `recheck` (#5326) each stage also gets `recheck-<stage>`, which runs
 * on a scheduled pipeline (`$CI_PIPELINE_SOURCE == "schedule"`; the schedule
 * is the project's pipeline schedule, set to `recheck`'s cron line) and runs
 * `<bin> components promote --to <stage> --pending`.
 *
 * With `agentFacts` (#5339) each job's variables also hold
 * `CHANT_AGENT_FACTS=verify-failed` and the relay key, so a failed verify
 * step or a soak check that starts failing records a fact for the
 * verify-failed agent.
 */

import { assertGitlabEnvironment, assertRunnerLabels, CI_IMAGE, environmentDoc, GITLAB_FULL_HISTORY, gitlabTags } from "@intentius/chant/ci-jobs";
import { opWaveBinArgv, opWaveJobTimeout } from "@intentius/chant/op/op-waves";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import { emitGitlabFile } from "./ci-jobs";
import { gitlabTradeIdTokens, gitlabTradeLines, TRADE_SPEC_ENV } from "@intentius/chant/ci-identity";
import { opWavesAgentFactsEnv } from "@intentius/chant/ci-agent-triggers";

const STAGE_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Render a pipeline's promote jobs as one GitLab CI file, `<pipeline>-promote.gitlab-ci.yml`. */
export function generateGitlabPipelinePromote(input: PipelinePromoteInput): Array<{ name: string; yaml: string }> {
  const subject = `Pipeline "${input.pipeline}" promote`;
  if (input.stages.length === 0) throw new Error(`${subject} has no stages; a promote needs at least one stage after the first.`);
  assertRunnerLabels(subject, "runner", input.runner, "GitLab");
  const seen = new Set<string>();
  for (const stage of input.stages) {
    if (!STAGE_NAME.test(stage.name)) throw new Error(`${subject}: stage ${JSON.stringify(stage.name)} is not a valid name; use lowercase letters, digits, "-" and "_".`);
    if (seen.has(stage.name)) throw new Error(`${subject}: stage "${stage.name}" is listed twice.`);
    seen.add(stage.name);
    if (stage.environment) assertGitlabEnvironment(`${input.pipeline}/${stage.name}`, stage.environment);
  }
  const timeout = opWaveJobTimeout(input.jobTimeoutMinutes);
  const bin = opWaveBinArgv(input.bin).join(" ");
  const tags = gitlabTags(input.runner);
  // #5339: with agentFacts, a failed verify or a soak check that starts failing records a fact for the verify-failed agent.
  const facts = input.agentFacts ? (opWavesAgentFactsEnv("gitlab", { ...input.agentFacts, triggers: ["verify-failed"] }) ?? {}) : {};
  const job = (stage: PipelinePromoteInput["stages"][number], rule: string, command: string) => ({
    image: CI_IMAGE,
    ...(tags ? { tags } : {}),
    timeout: `${timeout.minutes} minutes`,
    ...(stage.environment ? { environment: environmentDoc(stage.environment) } : {}),
    resource_group: `${input.pipeline}-promote-${stage.name}`,
    // #5348: the stage's own identity and its config and secret set.
    ...(stage.cloud ? { id_tokens: gitlabTradeIdTokens(stage.cloud) } : {}),
    variables: { ...GITLAB_FULL_HISTORY, ...(stage.variables ?? {}), ...(stage.cloud ? { [TRADE_SPEC_ENV]: JSON.stringify(stage.cloud) } : {}), ...facts },
    rules: [{ if: rule }],
    script: [...(stage.cloud ? gitlabTradeLines() : []), ...(stage.setup ?? []), command],
  });
  const entries: Array<readonly [string, unknown]> = input.stages.flatMap((stage): Array<readonly [string, unknown]> => [
    [`promote-${stage.name}`, job(stage, `$CI_PIPELINE_SOURCE == "web" && $CHANT_PROMOTE_STAGE == "${stage.name}"`, `${bin} components promote --to ${stage.name} --release "$CHANT_PROMOTE_RELEASE"`)],
    // #5326: the promotion a soak holds, tried again on a scheduled pipeline, in the stage's resource group.
    ...(input.recheck ? [[`recheck-${stage.name}`, job(stage, `$CI_PIPELINE_SOURCE == "schedule"`, `${bin} components promote --to ${stage.name} --pending`)] as const] : []),
  ]);
  const header = [
    `# chant promote for "${input.pipeline}": start a pipeline from the web with CHANT_PROMOTE_STAGE`,
    "# (one of " + input.stages.map((s) => s.name).join(", ") + ") and CHANT_PROMOTE_RELEASE (the release's label or digest).",
    ...(input.recheck ? [`# A pipeline schedule with the cron line "${input.recheck.schedule}" runs the recheck jobs; each promotes the release a soak holds.`] : []),
  ];
  return [{ name: `${input.pipeline}-promote.gitlab-ci.yml`, yaml: emitGitlabFile(entries, header) }];
}
