// The triage workflow — L5 capstone of the golden example.
//
// One alert in, a phased triage out: classify severity, gather context with
// tools, propose a remediation, gate on human approval when it's risky, then
// notify. Each non-gate phase is an activity implemented by the worker (later
// PRs); the activities run the agent — stubbed by default, real Claude when
// ANTHROPIC_API_KEY is set. The gate makes this Temporal-bound.
//
//   chant run alert-triage --temporal
//   chant run signal alert-triage approve-remediation
//
// This PR ships the Op skeleton and the app's manifests; the worker, the
// activities, and the WatchOp drift source land in follow-ups.
import { Op, phase, activity, gate } from "@intentius/chant-lexicon-temporal";

export default Op({
  name: "alert-triage",
  overview: "Triage an alert: classify, gather context, propose a fix, gate on approval, notify",
  taskQueue: "alert-triage",
  phases: [
    phase("Classify", [activity("classifyAlert")]),
    phase("Context", [activity("gatherContext")]),
    phase("Propose", [activity("proposeRemediation")]),
    phase("Approve", [
      gate("approve-remediation", {
        timeout: "12h",
        description: "Approve the proposed remediation before it is applied",
      }),
    ]),
    phase("Notify", [activity("notifyOutcome")]),
  ],
});
