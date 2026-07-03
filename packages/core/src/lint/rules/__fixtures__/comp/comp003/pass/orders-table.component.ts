import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP003 pass case: cfn-deploy has a known native rollback, so no opt-out is required. */
export const ordersTable: Component = {
  name: "orders-table",
  archetype: "infra",
  dependsOn: [],
  deploy: [phase("Apply", [{ kind: "cfn-deploy", template: "archive:orders-table.template.json", onReplace: "block" }])],
};
