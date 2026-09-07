import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP004 pass case: no gate step anywhere — nothing here stops the run for a person. */
export const ordersTable: Component = {
  name: "orders-table",
  archetype: "infra",
  dependsOn: [],
  deploy: [phase("Apply", [{ kind: "cfn-deploy", template: "archive:orders-table.template.json" }])],
};
