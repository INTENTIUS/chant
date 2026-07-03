import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP006 fail case: a raw "shell" step with no "reason" at all. */
export const legacyTool: Component = {
  name: "legacy-tool",
  archetype: "infra",
  dependsOn: [],
  deploy: [phase("Apply", [{ kind: "shell", cmd: "./legacy-deploy.sh" }])],
};
