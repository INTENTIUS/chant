import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP006 pass case: the "shell" escape hatch declares a non-empty reason. */
export const legacyTool: Component = {
  name: "legacy-tool",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [
      { kind: "shell", cmd: "./legacy-deploy.sh", reason: "no capability wraps this vendor's proprietary CLI yet" },
    ]),
  ],
};
