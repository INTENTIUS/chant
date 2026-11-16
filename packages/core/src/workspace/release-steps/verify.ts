/** `verified-releases`: `chant release verify` right before the publish. */
import type { ReleaseWorkflowFeature } from "./types";

export const verifyFeature: ReleaseWorkflowFeature = {
  name: "verify",
  steps: (c) => (c.verify && c.job === "publish" ? [{ slot: "beforePublish", order: 10, items: [`${c.chant} release verify ${c.label}`] }] : []),
};
