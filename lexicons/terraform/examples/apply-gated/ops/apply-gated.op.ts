/**
 * `TerraformApplyOp` with an explicit approval gate and a real rollback
 * command — the shape #2088's tier 2 asks for, alongside `getting-started`
 * (a bare root, no Op) and `scheduled-watch` (#2087, `TerraformWatchOp`).
 *
 * `gate: "always"` gates every apply, not only one that would destroy
 * something — appropriate when every change to this root needs a human in
 * the loop, not just a destructive one. Terraform has no automatic rollback,
 * so `compensate` here supplies a real command rather than leaving it unset:
 * `TerraformApplyOp` refuses `compensate: true` with no command at build
 * time, naming the Op, precisely so a rollback promise is never silently
 * empty.
 *
 * The estate is the `terraform/` directory next to this one, exactly as
 * `examples/getting-started` reads it (TF001 passes here for the same
 * reason: the root declares a `backend "local"`).
 *
 * A gate is a fact, not a wait. `chant run app-apply-gated` reads the gate
 * ledger, finds no resolution, records the gate as pending and ends with exit
 * 3 — nothing is held open. Record the answer with `chant approve
 * app-apply-gated approve-app-apply-gated --approver you`, then run it again:
 * the second run walks through the gate carrying the approver and applies.
 */

import { TerraformApplyOp } from "@intentius/chant-lexicon-terraform";

const { op } = TerraformApplyOp({
  name: "app-apply-gated",
  root: "app",
  gate: "always",
  compensate: { command: "terraform destroy -auto-approve" },
});

export default op;
