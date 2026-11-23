import type { Component } from "../../../../../../components/component";
import { gate, phase } from "../../../../../../components/component";

/** COMP009 pass case: the gate applies in staging only, and the test gates only the pipeline's prod stage. */
export const api: Component = {
  name: "api",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Roll", [
      gate("approve-api", { description: "Confirm before the roll", environments: ["staging"] }),
      { kind: "cfn-deploy", template: "api.template.json" },
    ]),
  ],
};
