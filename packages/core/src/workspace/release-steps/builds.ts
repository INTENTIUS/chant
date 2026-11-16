/** `release.workflow.builds` (#5152): the cut and publish jobs unpack each build job's archive into the project root. */
import { ACTION_PINS, usesRef } from "../../action-pins";
import { releaseBuildArchive, releaseBuildArtifact, type ReleaseBuildConfig } from "../release-toolchains";
import type { ReleaseWorkflowFeature } from "./types";

/** The shell line that packs a build job's outputs into its archive (#5152): tar keeps each file's path and mode, which an upload of the files would not. */
export function packLine(b: ReleaseBuildConfig): string {
  return `tar -cf ${releaseBuildArchive(b.name)} -- ${b.outputs.join(" ")}`;
}

/**
 * The shell line that unpacks a build's archive into the project root (#5152).
 * In the cut, `-k` refuses a file that is already there, so a build cannot
 * replace a file of the commit, and two builds cannot write one path.
 */
export function unpackLine(archive: string, cut: boolean): string {
  return `tar -x${cut ? "k" : ""}f ${archive}`;
}

/** The restore: in the cut before `release cut`, in the publish before the stamp. GitLab hands the archive into the project directory, so it is moved out after, and the publish finds the tree as the cut left it. */
export const buildsFeature: ReleaseWorkflowFeature = {
  name: "builds",
  steps: (c) => {
    if (c.shape !== "dispatch" || c.builds.length === 0) return [];
    const cut = c.job === "cut";
    const items =
      c.forge === "gitlab"
        ? c.builds.flatMap((b) => [unpackLine(releaseBuildArchive(b.name), cut), `mv ${releaseBuildArchive(b.name)} /tmp/`])
        : [
            {
              lines: c.builds.flatMap((b) => [
                `      - uses: ${usesRef(c.forge === "forgejo" ? ACTION_PINS.downloadArtifact3 : ACTION_PINS.downloadArtifact4)}`,
                "        with:",
                `          name: ${releaseBuildArtifact(b.name)}`,
                "          path: ${{ runner.temp }}/chant-release-builds",
                `      - run: ${unpackLine(`"$RUNNER_TEMP/chant-release-builds/${releaseBuildArchive(b.name)}"`, cut)}`,
              ]),
            },
          ];
    return [cut ? { slot: "beforeCut", order: 10, items } : { slot: "prepare", order: 27, items }];
  },
};
