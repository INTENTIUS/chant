// Reconcile the steward's own estate, behind a gate.
//
// No cadence: this one runs when someone asks for it, which is why the
// Steward lists it without giving it a Schedule. Listing it is still what
// tells `chant run steward-apply --on fountain` which thread the run belongs
// on.
//
// The gate is a fact on chant's ledger, not a wait held open inside the
// sandbox. A run that reaches it ends its turn with the approve line; a person
// records the resolution, and the next run walks through:
//
//   chant run steward-apply --on fountain
//   chant approve steward-apply approve-steward-apply --approver you
//   chant run approve steward-apply approve-steward-apply --on fountain

import { Op, activity, gate, phase } from "@intentius/chant/op";

const op = Op({
  name: "steward-apply",
  overview: "Apply the fountain manifest for this estate, after a human approves it",
  phases: [
    phase("Build", [activity("build", { path: "." })]),
    phase("Approve", [
      gate("approve-steward-apply", {
        timeout: "24h",
        description: "Approve reconciling the prod steward, its environment and its schedules",
      }),
    ]),
    phase("Apply", [
      activity("fountainApply", { manifestPath: "dist/fountain.yaml", profile: "prod" }),
    ]),
  ],
});

export default op;
