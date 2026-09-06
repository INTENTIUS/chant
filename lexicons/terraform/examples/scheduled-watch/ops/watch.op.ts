import { TerraformWatchOp } from "@intentius/chant-lexicon-terraform";

/**
 * Nightly drift for the `app` root: init, plan with `-detailed-exitcode`, and
 * open a GitHub issue whose body is the `terraform plan -no-color` render when
 * the plan is not empty.
 *
 * One-shot on the local executor: `chant run app-watch`. On a GitHub Actions
 * cron: `generateOpsPipeline` against the github lexicon, which turns this Op
 * plus its cron into a workflow file. On Temporal: the `schedule` exported
 * below.
 *
 * `schedule` is a `Temporal::Schedule`, exported so a project that runs
 * Temporal picks it up on `chant build`. A project that does not is the more
 * common case here, and for it the same cron reaches CI through
 * `generateOpsPipeline`. See `../../examples.test.ts` for the workflow that
 * produces, including the terraform install the runner needs.
 */
export const { op, schedule } = TerraformWatchOp({
  name: "app-watch",
  root: "app",
  schedule: "0 6 * * *",
  findingMode: "issue",
});

export default op;
