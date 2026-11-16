/** Sigstore signing (#5164): cosign in the jobs that run chant release, and the OIDC token the doctor checks. */
import { TOOL_PINS, toolInstallLine } from "../../tool-pins";
import type { OpSetupStep } from "../../lexicon";
import type { ReleasePipelineConfig, ReleaseWorkflowForge } from "../release-workflow";
import { RELEASE_RUNNER_PLATFORM, type ReleaseWorkflowFeature } from "./types";

/**
 * The step that installs cosign for Sigstore signing (#5164): the binary
 * {@link TOOL_PINS} pins for the runner's platform, downloaded to the job's
 * temp directory and checked against its SHA-256, and `CHANT_COSIGN` set to
 * it. A config whose `setup` already sets `CHANT_COSIGN` gets nothing.
 */
export function cosignSetup(forge: ReleaseWorkflowForge, p: ReleasePipelineConfig): OpSetupStep[] {
  if ((p.setup ?? []).some((s) => !("uses" in s) && s.run.includes("CHANT_COSIGN")) || p.env?.CHANT_COSIGN !== undefined) return [];
  if (forge === "gitlab") return [{ run: `${toolInstallLine(TOOL_PINS.cosign, RELEASE_RUNNER_PLATFORM, "/tmp")} && export CHANT_COSIGN=/tmp/cosign` }];
  return [{ name: `Install cosign ${TOOL_PINS.cosign.version}`, run: `${toolInstallLine(TOOL_PINS.cosign, RELEASE_RUNNER_PLATFORM, "$RUNNER_TEMP")} && echo "CHANT_COSIGN=$RUNNER_TEMP/cosign" >> "$GITHUB_ENV"` }];
}

/**
 * cosign after the config's setup, so a config that installs its own is left
 * alone. It goes in the jobs that run chant release (the cut, whose doctor
 * checks it, and the publish, which signs), never in a per-platform build
 * job. On GitLab the doctor in a dispatched cut gets the publish job's
 * `SIGSTORE_ID_TOKEN`, so it can check that signing will work.
 */
export const signingFeature: ReleaseWorkflowFeature = {
  name: "signing",
  setup: (c) => (c.signing ? { order: 40, steps: cosignSetup(c.forge, c.pipeline) } : null),
  steps: (c) =>
    c.signing && c.doctor && c.shape === "dispatch" && c.job === "cut" && c.forge === "gitlab"
      ? [{ slot: "jobKeys", order: 20, items: [{ lines: ["  id_tokens:", "    SIGSTORE_ID_TOKEN:", "      aud: sigstore"] }] }]
      : [],
};
