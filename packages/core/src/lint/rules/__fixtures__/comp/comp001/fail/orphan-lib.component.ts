import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP001 fail case: publishes an artifact nothing ever consumes — no other component references it, and no later step in this component references the Publish phase's output. */
export const orphanLib: Component = {
  name: "orphan-lib",
  archetype: "producer-library",
  dependsOn: [],
  build: { kind: "jvm-build", context: ".", into: "archive" },
  deploy: [phase("Publish", [{ kind: "publish-artifact", from: "archive", to: "$env.s3" }])],
};
