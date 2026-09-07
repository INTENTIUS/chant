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
 * `findingMode: "comment"` posts the plan as one comment on the pull request
 * that triggered the run and edits that same comment on the next push, found
 * by the hidden marker the `reconcilePr` activity writes as its first line
 * (chant #2231). It reads the pull request out of the run's own event
 * payload, so it needs the `pull_request` trigger above: the github generator
 * refuses the mode by name on any other one, and a run that somehow reaches
 * the Report step without a pull request fails there rather than posting the
 * plan somewhere nobody asked for it.
 */

import { TerraformWatchOp } from "@intentius/chant-lexicon-terraform";

const { op } = TerraformWatchOp({
  name: "app-plan",
  root: "app",
  findingMode: "comment",
  title: 'Terraform plan for root "app"',
});

export default op;
