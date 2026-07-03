import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP002 pass case: every wiring reference resolves — "@Publish.digest" points at this component's own "Publish" phase, and "@jar-lib.publish.uri" points at a discovered component listed in dependsOn. */
export const searchService: Component = {
  name: "search-service",
  archetype: "service",
  dependsOn: ["jar-lib"],
  build: { kind: "docker-build", context: ".", into: "archive" },
  deploy: [
    phase("Publish", [{ kind: "publish-image", from: "archive", to: "$env.registry" }]),
    phase("Apply", [
      {
        kind: "cfn-deploy",
        template: "archive:search.template.json",
        imageRef: "@Publish.digest",
        inputs: { jarUri: "@jar-lib.publish.uri" },
      },
      { kind: "ecs-update-service", cluster: "$env.cluster", service: "search" },
    ]),
    phase("Verify", [{ kind: "wait-steady-state", service: "search" }]),
  ],
};
