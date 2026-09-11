/**
 * The pull-request finding: what this change does to the estate's predicted
 * behaviour at `peak`'s level (chant #2358).
 *
 * `BehaviourOp` predicts the declared estate twice — on the pull request's
 * head and on its base branch — differences the two under the contract's
 * rules, and posts the finding as one sticky comment on the pull request
 * (GitHub, Forgejo) or one note on the merge request (GitLab). An entity the
 * engine declines is a row in the finding, not a zero; a pair whose
 * provenance or level differs is marked, not subtracted; and an engine that
 * is absent or unreachable produces a finding that says "no prediction" with
 * the refusal's own remedy.
 *
 * There is no `schedule` here. The cadence is the pull request, and the
 * trigger lives on the `ScheduledOpSpec` handed to `generateOpsPipeline`
 * (`{ kind: "pull_request" }`, `findingMode: "comment"`), the same way a
 * Terraform plan-on-pull-request Op is wired. The Op reads the base branch
 * off the run's own event (`GITHUB_BASE_REF` or
 * `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`); for a `chant run pr-behaviour`
 * on a developer's machine, pass `base` and `findingMode: "report"`.
 *
 * The Op itself is `Chant::Op` on the wire, which the coverage table declares
 * unmapped: an Op is a procedure chant runs, not a resource an account holds.
 * It is withheld from the engine's request by name, like the two profiles.
 */

import { BehaviourOp } from "@intentius/chant/op";

const { op } = BehaviourOp({
  name: "pr-behaviour",
  env: "dev",
  traffic: "1000 rps, p99",
});

export default op;
