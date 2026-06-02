import { ReconcileOp } from "@intentius/chant-lexicon-temporal";

// cloud → code. Snapshot the live `prod` stack, diff it against source, and on
// drift open a reviewable PR that regenerates the drifted/orphaned entities.
// Restricted to chant-owned resources (the ownership marker from chant.config).
//
// One-shot on the local executor:  chant run prod-reconcile
// Continuous on Temporal:           add `schedule` and run the generated worker.
export const { op: reconcileOp } = ReconcileOp({
  name: "prod-reconcile",
  env: "prod",
  onDrift: "pull-request",
  scope: { owned: true },
});
