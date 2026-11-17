/**
 * `chant release doctor` (#5161) in the release workflow: in a dispatched
 * release's cut job before the cut, unless `release.workflow.doctor` is
 * false, and in a tag-triggered publish job before the build under
 * `doctor: true`.
 */
import type { ReleaseWorkflowFeature } from "./types";

export const doctorFeature: ReleaseWorkflowFeature = {
  name: "doctor",
  steps: (c) => {
    if (!c.doctor) return [];
    // The cut job runs without id-token: write, which only the publish job holds, so the doctor there is told where it is.
    const items = [`${c.chant} release doctor${c.shape === "dispatch" && c.job === "cut" ? " --from cut" : ""}`];
    if (c.shape !== "dispatch") return c.job === "publish" ? [{ slot: "prepare", order: 10, items }] : [];
    if (c.job !== "cut") return [];
    // GitLab's cut runs it after the fetches, with the forge-checks token exported.
    return c.forge === "gitlab" ? [{ slot: "beforeCut", order: 30, items }] : [{ slot: "prepare", order: 10, items }];
  },
};
