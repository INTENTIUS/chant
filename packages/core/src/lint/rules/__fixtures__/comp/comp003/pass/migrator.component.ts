import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP003 pass case: "run-migration" is a needs-opt-out kind, but declares an explicit noRollback reason. */
export const migrator: Component = {
  name: "migrator",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [
      {
        kind: "run-migration",
        tool: "flyway",
        target: "ecs-task:migrate",
        noRollback: "forward-only schema migration; rolling back would drop columns already backfilled",
      },
    ]),
  ],
};
