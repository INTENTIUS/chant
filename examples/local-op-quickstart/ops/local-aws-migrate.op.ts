import { Op, phase, activity, effect, gate, shell, flociUp, build } from "@intentius/chant-lexicon-temporal";
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
 *   - receipt absent or stale → the gate pauses for approval, the migration
 *     runs, and only on success is the receipt written — last, once. A failed
 *     run leaves the receipt untouched, so the next run re-proposes it.
 *
 * The gate makes this Op need `--temporal` (the local executor refuses gates
 * by design — see local-aws.op.ts for the ungated local loop):
 *
 *   chant run local-aws-migrate --temporal --env local
 *   chant run signal local-aws-migrate approve-migration
 *
 * Floci serves as the local AWS: `flociUp` exports `AWS_ENDPOINT_URL`, which
 * the receipt store honors like every other read path (#1694), so the receipt
 * lands in the emulator's SSM and `aws ssm get-parameter --name
 * /chant-receipts/local-op-quickstart/local/demo-schema-seed` shows it.
 */
export default Op({
  name: "local-aws-migrate",
  overview: "Deploy locally, then a gated one-shot schema seed witnessed by an SSM effect receipt",
  taskQueue: "local-aws-migrate",
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
