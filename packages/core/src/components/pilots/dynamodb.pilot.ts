/**
 * Pilot: DynamoDB table (#555, epic #551).
 *
 * Exercises the sticky-apply axis: `cfn-deploy` carries declarative safety
 * options — `onReplace: "block"` refuses a changeset that would replace the
 * table (losing data) rather than update it in place, and `stageGsi: true`
 * stages a GSI change (add → backfill → remove) instead of an in-place
 * replace. That stickiness lives inside the `cfn-deploy` capability, exposed
 * as options, not scripted per component — see
 * capabilities.mdx#stickiness-lives-in-the-capability. `infra` archetype: no
 * build, apply → verify only. Verify fans out in parallel: the stack wait and
 * a GSI backfill migration have no ordering dependency on each other.
 *
 * The JSON projection of this pilot is authoritative at
 * ../__fixtures__/dynamodb-infra.json (already schema-validated by
 * component-schema.test.ts) — this module is the real typed `Component`
 * authoring form (#560, ../component.ts) that composes to that same
 * document; see ./pilots.test.ts, which asserts the two never diverge.
 */

import type { CfnDeployInput } from "../verbs/apply";
import type { Component } from "../component";
import { phase } from "../component";

const cfnSafetyOptions: Pick<CfnDeployInput, "onReplace" | "stageGsi"> = {
  onReplace: "block",
  stageGsi: true,
};

export const ordersTable: Component = {
  name: "orders-table",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [
      { kind: "cfn-deploy", template: "archive:orders-table.template.json", ...cfnSafetyOptions },
    ]),
    phase(
      "Verify",
      [
        { kind: "wait-for-stack", stack: "orders-table" },
        {
          kind: "run-migration",
          script: "archive:migrations/backfill-gsi.sql",
          // A GSI backfill has no clean inverse: once items are re-projected
          // onto the new index, "rolling back" the migration would mean a
          // second migration to undo it, not a mechanical compensation the
          // capability could run automatically — see COMP003
          // (lint-rules/composition.mdx) for the opt-out convention.
          noRollback: "GSI backfill is forward-only; undoing it needs a second, hand-written migration, not automatic compensation",
        },
      ],
      { parallel: true },
    ),
  ],
};
