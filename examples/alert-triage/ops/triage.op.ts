// The triage, as a chant Op.
//
// One alert in, a phased triage out: classify, gather context, propose a
// remediation, stop for a human, then apply and notify. The steps themselves
// are `activities/triage.ts`; `activities/run-triage.ts` sequences them either
// side of the gate and keeps the proposal on disk between the two runs, so
// what gets applied is what somebody actually read.
//
//   chant run triage                                         # ends "gated", exit 3
//   chant approve triage approve-remediation --approver you
//   chant run triage                                         # applies and notifies
//
// Every remediation passes the gate now, and that is a change worth naming.
// The workflow this replaces paid for a gate with a twelve-hour open wait, so
// it only spent that on remediations the classifier called risky and let the
// routine ones through unattended. A gate is a fact on chant's ledger since
// #2119 — nothing is held open between the two runs, and the second one is
// just another run — so there is no longer a cost to route everything through
// it. `risky` still does work: it is what the pending fact and the notify line
// say about the change somebody is being asked to clear.
import { Op, gate, phase, shell } from "@intentius/chant/op";

export default Op({
  name: "triage",
  overview: "Classify an alert, propose a remediation, apply it once a human clears it",
  phases: [
    phase("Propose", [
      shell("npx tsx activities/run-triage.ts propose", { profile: "fastIdempotent" }),
    ]),
    phase("Approve", [
      gate("approve-remediation", {
        timeout: "12h",
        description: "Approve the proposed remediation in .chant/triage/current.json",
      }),
    ]),
    phase("Remediate", [
      shell("npx tsx activities/run-triage.ts apply", { profile: "fastIdempotent" }),
    ]),
  ],
});
