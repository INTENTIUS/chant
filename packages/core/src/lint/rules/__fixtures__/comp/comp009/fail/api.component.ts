import type { Component } from "../../../../../../components/component";
import { gate, phase } from "../../../../../../components/component";

/** COMP009 fail case: the gate applies in staging and prod, and the test gives the pipeline's prod stage a gate. */
export const api: Component = {
  name: "api",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Roll", [
      gate("approve-api", { description: "Confirm before the roll", environments: ["staging", "prod"] }),
      { kind: "cfn-deploy", template: "api.template.json" },
    ]),
  ],
};
