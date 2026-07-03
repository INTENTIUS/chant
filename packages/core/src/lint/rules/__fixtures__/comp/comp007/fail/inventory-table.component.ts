import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP007 fail case: identical phase/step-kind shape to orders-table.component.ts. */
export const inventoryTable: Component = {
  name: "inventory-table",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [{ kind: "cfn-deploy", template: "archive:inventory-table.template.json" }]),
    phase("Verify", [{ kind: "wait-for-stack", stack: "inventory-table" }]),
  ],
};
