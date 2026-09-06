import { Op, phase, activity, effect, gate, shell, build } from "@intentius/chant/op";
import { flociUp } from "@intentius/chant-lexicon-aws";
import { schemaSeeded } from "./receipts";

/**
 * The local-aws deploy loop plus a gated one-shot migration, witnessed by an
 * effect receipt (chant #1835, epic #1703).
 *
 * `effect(schemaSeeded, [...])` wraps the nested steps in
 * read-compare-run-write over the receipt's SSM parameter
 * (/chant-receipts/local-op-quickstart/local/demo-schema-seed):
 *
 *   - receipt matches → the migration (and its gate) is skipped: "effect
 *     already applied". Re-runs are safe by construction.
 *   - receipt absent or stale → the run reaches the gate, records it pending
 *     and ends `gated` (exit 3). Once somebody records the resolution, the
 *     next run walks through, the migration runs, and only on success is the
 *     receipt written — last, once. A failed run leaves the receipt untouched,
 *     so the next run re-proposes it.
 *
 * The gate is a fact on the ledger, not a wait, so the whole loop is local
 * (see local-aws.op.ts for the ungated version):
 *
 *   chant run local-aws-migrate --env local
 *   chant approve local-aws-migrate approve-migration --approver you
 *   chant run local-aws-migrate --env local
 *
 * Floci serves as the local AWS: `flociUp` exports `AWS_ENDPOINT_URL`, which
 * the receipt store honors like every other read path (#1694), so the receipt
 * lands in the emulator's SSM and `aws ssm get-parameter --name
 * /chant-receipts/local-op-quickstart/local/demo-schema-seed` shows it.
 */
export default Op({
  name: "local-aws-migrate",
  overview: "Deploy locally, then a gated one-shot schema seed witnessed by an SSM effect receipt",
  phases: [
    phase("Emulator", [
      flociUp({ dockerSocket: true }),
    ]),
    phase("Build", [
      build("."),
    ]),
    phase("Deploy", [
      activity("nativeApply", { target: "cloudformation", env: "local", output: "dist/stack.json" }),
    ]),
    phase("Migrate", [
      effect(schemaSeeded, [
        gate("approve-migration", {
          timeout: "24h",
          description: "Approve the one-time demo schema seed (skipped when the receipt already matches)",
        }),
        shell("echo seeding demo schema v1"),
      ]),
    ]),
  ],
});
