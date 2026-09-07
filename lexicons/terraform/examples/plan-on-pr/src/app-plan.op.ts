/**
 * The pull-request half of the pair: init, plan, and report the plan.
 *
 * `TerraformWatchOp` never applies anything, which is the whole reason it is
 * the Op a pull request runs. `terraform plan -detailed-exitcode` is the
 * mechanism; the finding is the `-no-color` render of that plan, and nothing
 * else leaves the Op. The `-json` render stays inside it, because it carries
 * every resource attribute value the plan touched, provider credentials
 * among them (chant #2081's sensitive-output decision).
 *
 * There is no `schedule` here. The cadence of this Op is the pull request
 * itself, and that trigger lives on the `ScheduledOpSpec` handed to
 * `generateOpsPipeline` (`{ kind: "pull_request", branches: ["main"] }`,
 * chant #2084) rather than on the Op, the same way a cron would if this were
 * a nightly watch.
 *
 * `findingMode: "issue"` opens a GitHub issue whose body is the plan.
 * chant has no activity that comments on the triggering pull request today:
 * `reconcilePr`'s three modes are `report`, `issue` and `pull-request`, and
 * the last one regenerates chant TypeScript through `chant import`, which is
 * not what a terraform plan wants to say. See the README.
 */

import { TerraformWatchOp } from "@intentius/chant-lexicon-terraform";

const { op } = TerraformWatchOp({
  name: "app-plan",
  root: "app",
  findingMode: "issue",
  title: 'Terraform plan for root "app"',
});

export default op;
