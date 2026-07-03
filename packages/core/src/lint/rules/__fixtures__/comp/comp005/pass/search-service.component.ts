import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP005 pass case: every step kind is a verb (an operation), never the component's own name. */
export const searchService: Component = {
  name: "search-service",
  archetype: "service",
  dependsOn: [],
  build: { kind: "docker-build", context: ".", into: "archive" },
  deploy: [
    phase("Publish", [{ kind: "publish-image", from: "archive", to: "$env.registry" }]),
    phase("Apply", [
      { kind: "cfn-deploy", template: "archive:search.template.json", imageRef: "@Publish.digest" },
      { kind: "ecs-update-service", cluster: "$env.cluster", service: "search" },
    ]),
    phase("Verify", [{ kind: "wait-steady-state", service: "search" }]),
  ],
};
