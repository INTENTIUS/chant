/**
 * The push half of the pair: init, plan, gate, apply, on the branch the pull
 * request merged into.
 *
 * The apply never applies something no gate saw. `plan.out.planFile` is a
 * reference to the Plan step's own saved plan, so the file the approver read
 * is the file the Apply step names, and TF101 fails the build if that pairing
 * is ever spelled out as a literal path instead.
 *
 * A gate is a fact, not a wait. The push run reaches the gate, finds no
 * resolution on the ledger, records the pending fact and ends with status
 * `gated`, so the workflow run stops there rather than holding a runner open.
 * `chant approve app-apply approve-app-apply --approver you` writes the
 * resolution, and re-running the workflow walks through the gate and applies.
 * `gate: "never"` is how a root that wants an unattended apply on merge drops
 * the stop.
 *
 * A gated run exits 3 by default, which on a push job is a red workflow run on
 * every merge until someone approves. The generated push job runs with
 * `--gated-exit 0` and a follow-up job that posts the pending gate on the
 * merged pull request, so the merge is green and the wait is visible
 * (chant #2243). Only the gated outcome is mapped; a broken apply is still
 * red.
 *
 * The trigger, like the plan Op's, lives on the `ScheduledOpSpec`:
 * `{ kind: "push", branches: ["main"] }`.
 */

import { TerraformApplyOp } from "@intentius/chant-lexicon-terraform";

const { op } = TerraformApplyOp({
  name: "app-apply",
  root: "app",
  gate: "always",
});

export default op;
