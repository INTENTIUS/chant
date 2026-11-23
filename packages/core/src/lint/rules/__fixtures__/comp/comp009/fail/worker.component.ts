import type { Component } from "../../../../../../components/component";
import { gate, phase } from "../../../../../../components/component";

/** COMP009 fail case: a gate with no environments applies in every environment, prod included. */
export const worker: Component = {
  name: "worker",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Roll", [
      gate("approve-worker", { description: "Confirm before the roll" }),
      { kind: "cfn-deploy", template: "worker.template.json" },
    ]),
  ],
};
