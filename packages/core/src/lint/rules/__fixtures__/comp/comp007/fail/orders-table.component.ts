import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP007 fail case: identical phase/step-kind shape to inventory-table.component.ts — a declaration-sprawl hint (should reach for a preset). */
export const ordersTable: Component = {
  name: "orders-table",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [{ kind: "cfn-deploy", template: "archive:orders-table.template.json" }]),
    phase("Verify", [{ kind: "wait-for-stack", stack: "orders-table" }]),
  ],
};
