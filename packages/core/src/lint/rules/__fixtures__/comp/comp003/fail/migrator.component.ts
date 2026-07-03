import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP003 fail case: "run-migration" has no native rollback, no noRollback opt-out, no component-level rollback, and no compensation sibling step. */
export const migrator: Component = {
  name: "migrator",
  archetype: "infra",
  dependsOn: [],
  deploy: [phase("Apply", [{ kind: "run-migration", tool: "flyway", target: "ecs-task:migrate" }])],
};
