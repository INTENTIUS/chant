/** `release.version` (#4840): the publish job stamps the label before the images and the build. The cut stamps on its own. */
import type { ReleaseWorkflowFeature } from "./types";

export const stampFeature: ReleaseWorkflowFeature = {
  name: "stamp",
  steps: (c) => (c.version && c.job === "publish" ? [{ slot: "prepare", order: 30, items: [`${c.chant} release stamp ${c.label}`] }] : []),
};
