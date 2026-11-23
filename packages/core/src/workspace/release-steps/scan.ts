/** The vulnerability scan before the stage (#5446): grype and syft in the jobs that run chant release. */
import { TOOL_PINS, toolInstallLineForRunner } from "../../tool-pins";
import type { OpSetupStep } from "../../lexicon";
import type { ReleasePipelineConfig, ReleaseWorkflowForge } from "../release-workflow";
import type { ReleaseWorkflowFeature } from "./types";

/** Whether the config's setup or env already names `variable`, so it brings its own tool. */
function brings(p: ReleasePipelineConfig, variable: string): boolean {
  return (p.setup ?? []).some((s) => !("uses" in s) && s.run.includes(variable)) || p.env?.[variable] !== undefined;
}

/**
 * The steps that install the scanner and syft for the scan before the stage
 * (#5446): the binaries {@link TOOL_PINS} pins for the runner's platform,
 * downloaded to the job's temp directory, checked against their SHA-256,
 * and named by `CHANT_GRYPE` and `CHANT_SYFT`. A config whose setup or env
 * already sets one of them gets no install of that tool.
 */
export function scanSetup(forge: ReleaseWorkflowForge, p: ReleasePipelineConfig): OpSetupStep[] {
  const tools = [
    { pin: TOOL_PINS.grype, variable: "CHANT_GRYPE" },
    { pin: TOOL_PINS.syft, variable: "CHANT_SYFT" },
  ].filter((t) => !brings(p, t.variable));
  return tools.map(({ pin, variable }) =>
    forge === "gitlab"
      ? { run: `${toolInstallLineForRunner(pin, `/tmp/${pin.name}`)} && export ${variable}=/tmp/${pin.name}/${pin.name}` }
      : { name: `Install ${pin.name} ${pin.version}`, run: `${toolInstallLineForRunner(pin, `$RUNNER_TEMP/${pin.name}`)} && echo "${variable}=$RUNNER_TEMP/${pin.name}/${pin.name}" >> "$GITHUB_ENV"` },
  );
}

/**
 * The scanner after the config's setup, in the jobs that run chant release:
 * the cut, whose doctor checks it, and the publish, which scans. A train's
 * jobs get it through the same setup steps.
 */
export const scanFeature: ReleaseWorkflowFeature = {
  name: "scan",
  setup: (c) => (c.scan ? { order: 41, steps: scanSetup(c.forge, c.pipeline) } : null),
};
