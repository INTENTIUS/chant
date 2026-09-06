import { ApplyOp } from "@intentius/chant/op";

// code → cloud. Build the template, compute the plan, wait for approval, then
// apply via CloudFormation. `delete: "gated"` makes deletes ride the
// marker-scoped path (only chant-owned orphans) behind the approval gate, and
// turns on saga-style rollback on partial failure.
//
// A gate is a fact, not a wait. `chant run prod-apply` reads the gate ledger,
// finds no resolution, records the gate as pending and ends with exit 3.
// Record the answer with `chant approve prod-apply approve-prod-apply
// --approver you`, then run it again and the apply proceeds.
const { op } = ApplyOp({
  name: "prod-apply",
  env: "prod",
  target: "cloudformation",
  delete: "gated",
});

export default op;
