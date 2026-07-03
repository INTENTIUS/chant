import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP005 fail case: the Apply step's kind is named after this very component ("deploy-search-service") — a noun, not an operation. */
export const searchService: Component = {
  name: "search-service",
  archetype: "service",
  dependsOn: [],
  build: { kind: "docker-build", context: ".", into: "archive" },
  deploy: [
    phase("Publish", [{ kind: "publish-image", from: "archive", to: "$env.registry" }]),
    phase("Apply", [{ kind: "deploy-search-service", imageRef: "@Publish.digest" }]),
  ],
};
