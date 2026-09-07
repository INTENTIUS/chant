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
 * `gated` and exit 3, so the workflow run stops there rather than holding a
 * runner open. `chant approve app-apply approve-app-apply --approver you`
 * writes the resolution, and re-running the workflow walks through the gate
 * and applies. `gate: "never"` is how a root that wants an unattended apply
 * on merge drops the stop.
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
