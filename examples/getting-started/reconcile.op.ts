// L4 — the lifecycle dial, position 2: reconcile (cloud → code).
//
// ReconcileOp snapshots, plans against live, and when the cluster has drifted
// from your declarations it regenerates the affected TypeScript and opens a PR.
// It pulls reality back into source; it never writes to the cluster. Scoped to
// chant-owned resources. One-shot on the local executor (no schedule here).
//
//   chant run reconcile
import { ReconcileOp } from "@intentius/chant-lexicon-temporal";

const reconcile = ReconcileOp({
  name: "reconcile",
  env: "local",
  onDrift: "pull-request",
  scope: { owned: true },
});

export default reconcile.op;
