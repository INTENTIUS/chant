import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/**
 * COMP003 pass case (#1944): a bare "run-agent" step with no "noRollback"
 * opt-out and no component-level "rollback" — must pass COMP003 because
 * "run-agent"'s rollbackPolicy is "native" (#1941), not "needs-opt-out". This
 * is the regression test proving the registry's declared rollbackPolicy for
 * "run-agent" is wired correctly into ctx.rollbackPolicies, the same seam
 * COMP005 uses for ctx.knownKinds — see comp.test.ts's FIXTURE_ROLLBACK_POLICIES.
 */
export const agentTurn: Component = {
  name: "agent-turn",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Run", [
      {
        kind: "run-agent",
        agent: "claude",
        task: { prompt: "run the migration script and report the result" },
        workspace: {},
      },
    ]),
  ],
};
