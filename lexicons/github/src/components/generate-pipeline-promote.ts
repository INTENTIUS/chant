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
 * read the stage's store secrets before the command. The forgejo generator reuses {@link buildGithubPromoteDoc}.
 *
 * With `recheck` (#5326) the workflow also runs on that schedule, and each
 * stage gets a `recheck-<stage>` job, with the same identity, set and
 * environment, that runs `<bin> components promote --to <stage> --pending`:
 * the promotion a soak holds, tried again.
 */

import { opWaveBinArgv, opWaveJobTimeout } from "@intentius/chant/op/op-waves";
import type { PipelinePromoteInput } from "@intentius/chant/lexicon";
import { assertEnvironment, CI_IMAGE, environmentDoc, githubRunsOn } from "@intentius/chant/ci-jobs";
import { checkoutStep, concurrency } from "./ci-jobs";
import { OIDC_REQUEST_VARS, TRADE_SPEC_ENV, tradeLine } from "@intentius/chant/ci-identity";
import { emitOpPipelineYAML, type GithubOpPipelineDoc } from "./generate-op-pipeline";

/** The env var a promote job reads the release from. */
export const PROMOTE_RELEASE_ENV = "CHANT_PROMOTE_RELEASE";

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
  }
}

/** The workflow document, before emission. */
export function buildGithubPromoteDoc(input: PipelinePromoteInput, _dialect: { forge?: "github" | "forgejo" } = {}): GithubOpPipelineDoc {
  assertPipelinePromote(input);
  const timeout = opWaveJobTimeout(input.jobTimeoutMinutes);
  const bin = opWaveBinArgv(input.bin).join(" ");
  const jobsDoc: Record<string, unknown> = {};
  for (const stage of input.stages) {
    if (stage.environment) assertEnvironment(`${input.pipeline}/${stage.name}`, stage.environment);
    // #5348: the stage's own identity, traded for before the checkout, and its config and secret set.
    const cloud = stage.cloud;
    const job = (condition: string, step: string, command: string, env: Record<string, string>) => ({
      if: condition,
      "runs-on": githubRunsOn(input.runner),
      ...(stage.environment ? { environment: environmentDoc(stage.environment) } : {}),
      ...(cloud ? { permissions: { contents: "write", "id-token": "write" } } : {}),
      "timeout-minutes": timeout.minutes,
      container: CI_IMAGE,
      concurrency: concurrency(`${input.pipeline}-promote-${stage.name}`, false),
      steps: [
        ...(cloud ? [{ name: "Trade the job's OIDC token for the stage's cloud identity", env: { [TRADE_SPEC_ENV]: JSON.stringify(cloud) }, run: tradeLine("$GITHUB_ENV", "github-env") }] : []),
        checkoutStep(true),
        { name: step, ...(Object.keys({ ...stage.variables, ...env }).length > 0 ? { env: { ...(stage.variables ?? {}), ...env } } : {}), run: [...(cloud ? [`unset ${OIDC_REQUEST_VARS.join(" ")}`] : []), ...(stage.setup ?? []), command].join("\n") },
      ],
    });
    jobsDoc[`promote-${stage.name}`] = job(
      `\${{ inputs.stage == '${stage.name}' }}`,
      `Promote the release into ${stage.name}`,
      `${bin} components promote --to ${stage.name} --release "$${PROMOTE_RELEASE_ENV}"`,
      { [PROMOTE_RELEASE_ENV]: "${{ inputs.release }}" },
    );
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
