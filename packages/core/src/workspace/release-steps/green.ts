/** `release.green: "forge-checks"` (#5149): GitLab's cut asks the forge for the commit's checks with the release token unless a token of its own is set. */
import type { ReleaseWorkflowFeature } from "./types";

export const greenFeature: ReleaseWorkflowFeature = {
  name: "green",
  steps: (c) =>
    c.green === "forge-checks" && c.shape === "dispatch" && c.job === "cut" && c.forge === "gitlab"
      ? [{ slot: "beforeCut", order: 20, items: ['export CHANT_GITLAB_TOKEN="${CHANT_GITLAB_TOKEN:-$CHANT_RELEASE_TOKEN}"'] }]
      : [],
};
