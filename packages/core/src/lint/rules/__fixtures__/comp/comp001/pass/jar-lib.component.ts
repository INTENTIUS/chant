import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** Producer whose published artifact IS consumed downstream (by emr-job.component.ts) — COMP001 must not flag this. */
export const jarLib: Component = {
  name: "jar-lib",
  archetype: "producer-library",
  dependsOn: [],
  build: { kind: "jvm-build", context: ".", into: "archive" },
  deploy: [phase("Publish", [{ kind: "publish-artifact", from: "archive", to: "$env.s3" }])],
};
