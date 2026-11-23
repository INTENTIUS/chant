/** Sigstore signing (#5164): cosign in the jobs that run chant release, the OIDC token the doctor checks, and (#5458) the key's variables in the publish step. */
import { TOOL_PINS, toolInstallLineForRunner } from "../../tool-pins";
import type { OpSetupStep } from "../../lexicon";
import type { ReleasePipelineConfig, ReleaseWorkflowForge } from "../release-workflow";
import type { ReleaseWorkflowFeature } from "./types";

/**
 * The step that installs cosign for Sigstore signing (#5164): the binary
 * {@link TOOL_PINS} pins for the runner's platform, downloaded to the job's
 * temp directory and checked against its SHA-256, and `CHANT_COSIGN` set to
 * it. A config whose `setup` already sets `CHANT_COSIGN` gets nothing.
 */
export function cosignSetup(forge: ReleaseWorkflowForge, p: ReleasePipelineConfig): OpSetupStep[] {
  if ((p.setup ?? []).some((s) => !("uses" in s) && s.run.includes("CHANT_COSIGN")) || p.env?.CHANT_COSIGN !== undefined) return [];
  if (forge === "gitlab") return [{ run: `${toolInstallLineForRunner(TOOL_PINS.cosign, "/tmp")} && export CHANT_COSIGN=/tmp/cosign` }];
  return [{ name: `Install cosign ${TOOL_PINS.cosign.version}`, run: `${toolInstallLineForRunner(TOOL_PINS.cosign, "$RUNNER_TEMP")} && echo "CHANT_COSIGN=$RUNNER_TEMP/cosign" >> "$GITHUB_ENV"` }];
}

/**
 * The publish step's own variables for signing (#5458) on GitHub and
 * Forgejo: each of `vars` from the repository's secret of the same name,
 * unless `release.workflow.env` sets it for the job already. Signing runs
 * inside `chant release publish`, so that step is the signing step, and no
 * other step or job gets them. GitLab gets none: there they are the
 * project's CI/CD variables, which the platform hands to every job.
 */
export function signingStepEnv(forge: ReleaseWorkflowForge, p: ReleasePipelineConfig, vars: readonly string[]): string[] {
  if (forge === "gitlab") return [];
  return [...new Set(vars)].filter((v) => p.env?.[v] === undefined).map((v) => `${v}: \${{ secrets.${v} }}`);
}

/**
 * cosign after the config's setup, so a config that installs its own is left
 * alone. It goes in the jobs that run chant release (the cut, whose doctor
 * checks it, and the publish, which signs), never in a per-platform build
 * job. On GitLab the doctor in a dispatched cut gets the publish job's
 * `SIGSTORE_ID_TOKEN`, so it can check that signing will work. A key's
 * variables go to the publish step alone (#5458).
 */
export const signingFeature: ReleaseWorkflowFeature = {
  name: "signing",
  setup: (c) => (c.signing ? { order: 40, steps: cosignSetup(c.forge, c.pipeline) } : null),
  steps: (c) => [
    ...(c.signing && c.doctor && c.shape === "dispatch" && c.job === "cut" && c.forge === "gitlab"
      ? [{ slot: "jobKeys" as const, order: 20, items: [{ lines: ["  id_tokens:", "    SIGSTORE_ID_TOKEN:", "      aud: sigstore"] }] }]
      : []),
    ...(c.signing && c.job === "publish" && c.signingEnv.length > 0 ? [{ slot: "publishEnv" as const, order: 20, items: signingStepEnv(c.forge, c.pipeline, c.signingEnv) }] : []),
  ],
};
