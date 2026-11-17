/** goreleaser for the `release.artifacts` entries it builds (#5151). */
import { ACTION_PINS, usesRef } from "../../action-pins";
import { TOOL_PINS, toolInstallLine } from "../../tool-pins";
import { buildJobToolchains } from "../release-toolchains";
import type { ReleasePipelineConfig, ReleaseWorkflowForge } from "../release-workflow";
import { RELEASE_RUNNER_PLATFORM, type ReleaseWorkflowFeature } from "./types";

/**
 * What a job that builds goreleaser entries runs first (#5151): Go from the
 * member's `go.mod` (GitHub and Forgejo, unless the job's toolchains set Go
 * up already or `release.workflow.setup` names `actions/setup-go`), without
 * a cache like every other setup step, then the pinned goreleaser, downloaded, checked
 * by SHA-256 and named by `CHANT_GORELEASER`. A config that sets
 * `CHANT_GORELEASER` in `release.workflow.env` gets no install. GitLab
 * jobs run in the project's image, which brings its own Go.
 */
export function goreleaserSetup(forge: ReleaseWorkflowForge, root: string | null, p: ReleasePipelineConfig, goSetUp = false): { github: string[]; gitlab: string[] } {
  const install = p.env?.CHANT_GORELEASER === undefined;
  if (forge === "gitlab") {
    return { github: [], gitlab: install ? [`${toolInstallLine(TOOL_PINS.goreleaser, RELEASE_RUNNER_PLATFORM, "/tmp/goreleaser")} && export CHANT_GORELEASER=/tmp/goreleaser/goreleaser`] : [] };
  }
  const go =
    goSetUp || (p.setup ?? []).some((s) => "uses" in s && /^actions\/setup-go@/.test(s.uses))
      ? []
      : [`      - uses: ${usesRef(ACTION_PINS.setupGo7)}`, "        with:", `          go-version-file: ${root ? `${root}/` : ""}go.mod`, "          cache: false"];
  const line = `${toolInstallLine(TOOL_PINS.goreleaser, RELEASE_RUNNER_PLATFORM, "$RUNNER_TEMP/goreleaser")} && echo "CHANT_GORELEASER=$RUNNER_TEMP/goreleaser/goreleaser" >> "$GITHUB_ENV"`;
  return { github: [...go, ...(install ? [`      - name: goreleaser ${TOOL_PINS.goreleaser.version}`, `        run: ${JSON.stringify(line)}`] : [])], gitlab: [] };
}

/** The job's toolchains (#5152) set Go up already, from `release.workflow.toolchains` or a `go.mod` at the project's root (#5268). */
export function setsUpGo(p: ReleasePipelineConfig, projectFiles: readonly string[] | undefined, root: string | null): boolean {
  return buildJobToolchains(p.toolchains, projectFiles, root).some((t) => t.name === "go");
}

/** In the job that builds the files: a dispatched release's cut, or a tag's publish. */
export const goreleaserFeature: ReleaseWorkflowFeature = {
  name: "goreleaser",
  steps: (c) => {
    if (!c.artifacts || c.input.goreleaser !== true) return [];
    if (c.job !== (c.shape === "dispatch" ? "cut" : "publish")) return [];
    const g = goreleaserSetup(c.forge, c.root, c.pipeline, setsUpGo(c.pipeline, c.input.projectFiles, c.root));
    const items = c.forge !== "gitlab" ? [{ lines: g.github }] : c.shape === "dispatch" ? g.gitlab : [{ lines: g.gitlab.map((l) => `    - ${JSON.stringify(l)}`) }];
    return [{ slot: "prepare", order: 20, items }];
  },
};
