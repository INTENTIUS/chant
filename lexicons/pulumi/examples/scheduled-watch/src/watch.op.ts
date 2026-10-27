import { PulumiWatchOp } from "@intentius/chant-lexicon-pulumi";

/**
 * Every morning at 06:00: `pulumi preview --json` in `infra/` for the
 * `Changes` outcome, then one `pulumi refresh --preview-only --json --target
 * <urn>` per resource in `infra/stack-export.json` for the `Drift` outcome.
 * Neither changes the stack, and the Op has no apply step.
 *
 * One-shot on the local executor: `chant run infra-watch`. `chant operator`
 * ticks it on the cron, and `generateOpsPipeline` renders the cron as a CI
 * schedule.
 */
export const { op } = PulumiWatchOp({
  name: "infra-watch",
  member: "infra",
  dir: "./infra",
  stack: "dev",
  schedule: "0 6 * * *",
});

export default op;
