import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/**
 * COMP002 fail case: two dangling wiring references.
 *  - "@Build.digest" names a phase ("Build") that does not exist in this
 *    component's deploy (the actual phase is named "Publish").
 *  - "@missing-lib.publish.uri" names a component that was never discovered
 *    at all in this fixture directory.
 */
export const searchService: Component = {
  name: "search-service",
  archetype: "service",
  dependsOn: [],
  build: { kind: "docker-build", context: ".", into: "archive" },
  deploy: [
    phase("Publish", [{ kind: "publish-image", from: "archive", to: "$env.registry" }]),
    phase("Apply", [
      {
        kind: "cfn-deploy",
        template: "archive:search.template.json",
        imageRef: "@Build.digest",
        inputs: { jarUri: "@missing-lib.publish.uri" },
      },
    ]),
  ],
};
