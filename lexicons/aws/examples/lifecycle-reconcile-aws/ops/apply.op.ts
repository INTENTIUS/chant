import { ApplyOp } from "@intentius/chant-lexicon-temporal";

// code → cloud. Build the template, compute the plan, wait for approval, then
// apply via CloudFormation. `delete: "gated"` makes deletes ride the
// marker-scoped path (only chant-owned orphans) behind the approval gate, and
// turns on saga-style rollback on partial failure.
//
// Gated/destructive applies require the Temporal executor (the local executor
// rejects gates): `chant run prod-apply --temporal`, then signal
// `approve-prod-apply`.
const { op } = ApplyOp({
  name: "prod-apply",
  env: "prod",
  target: "cloudformation",
  delete: "gated",
});

export default op;
