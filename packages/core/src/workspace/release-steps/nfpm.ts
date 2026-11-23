/** nfpm for the `release.artifacts` entries it packages (#5233). */
import { TOOL_PINS, toolInstallLineForRunner } from "../../tool-pins";
import type { ReleasePipelineConfig, ReleaseWorkflowForge } from "../release-workflow";
import type { ReleaseWorkflowFeature } from "./types";

/**
 * What a job that packages nfpm entries runs first: the pinned nfpm,
 * downloaded, checked by SHA-256 and named by `CHANT_NFPM`. A config that
 * sets `CHANT_NFPM` in `release.workflow.env` gets no install.
 */
export function nfpmSetup(forge: ReleaseWorkflowForge, p: ReleasePipelineConfig): { github: string[]; gitlab: string[] } {
  if (p.env?.CHANT_NFPM !== undefined) return { github: [], gitlab: [] };
  if (forge === "gitlab") return { github: [], gitlab: [`${toolInstallLineForRunner(TOOL_PINS.nfpm, "/tmp/nfpm")} && export CHANT_NFPM=/tmp/nfpm/nfpm`] };
  const line = `${toolInstallLineForRunner(TOOL_PINS.nfpm, "$RUNNER_TEMP/nfpm")} && echo "CHANT_NFPM=$RUNNER_TEMP/nfpm/nfpm" >> "$GITHUB_ENV"`;
  return { github: [`      - name: nfpm ${TOOL_PINS.nfpm.version}`, `        run: ${JSON.stringify(line)}`], gitlab: [] };
}

/** In the job that builds the files: a dispatched release's cut, or a tag's publish. */
export const nfpmFeature: ReleaseWorkflowFeature = {
  name: "nfpm",
  steps: (c) => {
    if (!c.artifacts || c.input.nfpm !== true) return [];
    if (c.job !== (c.shape === "dispatch" ? "cut" : "publish")) return [];
    const n = nfpmSetup(c.forge, c.pipeline);
    const items = c.forge !== "gitlab" ? [{ lines: n.github }] : c.shape === "dispatch" ? n.gitlab : [{ lines: n.gitlab.map((l) => `    - ${JSON.stringify(l)}`) }];
    return [{ slot: "prepare", order: 21, items }];
  },
};
