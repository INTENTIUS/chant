import { TerraformWatchOp } from "@intentius/chant-lexicon-terraform";

/**
 * Nightly drift for the `app` root: init, plan with `-detailed-exitcode`, and
 * open a GitHub issue whose body is the `terraform plan -no-color` render when
 * the plan is not empty.
 *
 * One-shot on the local executor: `chant run app-watch`. On a GitHub Actions
 * cron: `generateOpsPipeline` against the github lexicon, which turns this Op
 * plus its cron into a workflow file.
 *
 * The cron lands on the Op itself as `schedule` (#2120) — runtime-neutral
 * data. `chant operator` ticks on it, `generateOpsPipeline` renders it as the
 * workflow's `on: schedule`, and a hosting lexicon hands it to its own
 * scheduler. See `../../examples.test.ts` for the workflow that produces,
 * including the terraform install the runner needs.
 */
export const { op } = TerraformWatchOp({
  name: "app-watch",
  root: "app",
  schedule: "0 6 * * *",
  findingMode: "issue",
});

export default op;
