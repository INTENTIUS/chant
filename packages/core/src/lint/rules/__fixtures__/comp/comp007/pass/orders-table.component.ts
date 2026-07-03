import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

export const ordersTable: Component = {
  name: "orders-table",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [{ kind: "cfn-deploy", template: "archive:orders-table.template.json", onReplace: "block" }]),
    phase("Verify", [{ kind: "wait-for-stack", stack: "orders-table" }]),
  ],
};
