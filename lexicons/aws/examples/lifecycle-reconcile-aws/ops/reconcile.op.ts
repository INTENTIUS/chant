import { ReconcileOp } from "@intentius/chant/op";

// cloud → code. Snapshot the live `prod` stack, diff it against source, and on
// drift open a reviewable PR that regenerates the drifted/orphaned entities.
// Restricted to chant-owned resources (the ownership marker from chant.config).
//
// One-shot on the local executor:  chant run prod-reconcile
// Continuous:                      add `schedule` and let `chant operator` or
//                                  a generated CI cron tick it.
const { op } = ReconcileOp({
  name: "prod-reconcile",
  env: "prod",
  onDrift: "pull-request",
  scope: { owned: true },
});

export default op;
