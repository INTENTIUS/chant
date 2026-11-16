/**
 * `release.artifacts` (#5151). In a dispatched release the cut job stages the
 * files it built (`chant release artifacts --no-build -o`) and hands them to
 * the publish job as the workflow artifact {@link RELEASE_ARTIFACTS_ARTIFACT},
 * which checks them against the record (`--from`) after its build. On a
 * release tag the publish job builds them again and checks them.
 */
import { ACTION_PINS, usesRef } from "../../action-pins";
import type { ReleaseWorkflowForge } from "../release-workflow";
import type { ReleaseWorkflowFeature } from "./types";

/** The workflow artifact the cut job hands the files `release.artifacts` built on in (#5151). */
export const RELEASE_ARTIFACTS_ARTIFACT = "chant-release-artifacts";

/** Where a job stages, and the publish job finds, the files the cut built (#5151): outside the checkout on GitHub and Forgejo; GitLab keeps job artifacts only inside the project directory, so its publish job moves them out first. */
export const RELEASE_ARTIFACTS_STAGE: Record<ReleaseWorkflowForge, string> = {
  github: "$RUNNER_TEMP/chant-release-artifacts",
  forgejo: "$RUNNER_TEMP/chant-release-artifacts",
  gitlab: "$CI_PROJECT_DIR/.chant-release-artifacts",
};

export const artifactsFeature: ReleaseWorkflowFeature = {
  name: "artifacts",
  steps: (c) => {
    if (!c.artifacts) return [];
    if (c.shape !== "dispatch") return c.job === "publish" ? [{ slot: "beforeBuild", order: 20, items: [`${c.chant} release artifacts ${c.label}`] }] : [];
    const gitlab = c.forge === "gitlab";
    if (c.job === "cut") {
      const stage = `${c.chant} release artifacts ${c.label} --no-build -o "${RELEASE_ARTIFACTS_STAGE[c.forge]}"`;
      if (gitlab) return [{ slot: "afterCut", order: 10, items: [stage] }, { slot: "artifactPaths", order: 20, items: [{ lines: ['      - ".chant-release-artifacts/"'] }] }];
      const upload = usesRef(c.forge === "forgejo" ? ACTION_PINS.uploadArtifact3 : ACTION_PINS.uploadArtifact4);
      return [{ slot: "afterCut", order: 10, items: [stage, { lines: [`      - uses: ${upload}`, "        with:", `          name: ${RELEASE_ARTIFACTS_ARTIFACT}`, "          path: ${{ runner.temp }}/chant-release-artifacts", "          if-no-files-found: error", "          retention-days: 1"] }] }];
    }
    if (gitlab) {
      return [
        // The staged files leave the checkout, which the publish finds as the cut left it.
        { slot: "afterCheckout", order: 10, items: ['mv "$CI_PROJECT_DIR/.chant-release-artifacts" /tmp/chant-release-artifacts'] },
        { slot: "afterBuild", order: 10, items: [`${c.chant} release artifacts ${c.label} --from /tmp/chant-release-artifacts`] },
      ];
    }
    const download = usesRef(c.forge === "forgejo" ? ACTION_PINS.downloadArtifact3 : ACTION_PINS.downloadArtifact4);
    return [
      { slot: "beforeBuild", order: 20, items: [{ lines: [`      - uses: ${download}`, "        with:", `          name: ${RELEASE_ARTIFACTS_ARTIFACT}`, "          path: ${{ runner.temp }}/chant-release-artifacts"] }] },
      { slot: "afterBuild", order: 10, items: [`${c.chant} release artifacts ${c.label} --from "${RELEASE_ARTIFACTS_STAGE[c.forge]}"`] },
    ];
  },
};
