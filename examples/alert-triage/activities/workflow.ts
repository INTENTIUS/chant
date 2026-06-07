// The triage workflow — raw Temporal (workflow-sandbox-safe).
//
// One alert in, a phased triage out: classify, gather context, propose a
// remediation, gate on human approval when it's risky, then notify. The
// activities (./triage) run in the worker; here they're called through
// `proxyActivities`. `import type` keeps the activity module out of the
// deterministic workflow bundle.
import { proxyActivities, defineSignal, setHandler, condition } from "@temporalio/workflow";
import type * as activities from "./triage";
import type { Alert } from "./triage";

const { classifyAlert, gatherContext, proposeRemediation, notifyOutcome } =
  proxyActivities<typeof activities>({ startToCloseTimeout: "1 minute" });

/** Approve a risky remediation. */
export const approveRemediation = defineSignal("approve-remediation");

export async function alertTriage(alert: Alert): Promise<void> {
  const classification = await classifyAlert(alert);
  const context = await gatherContext(alert);
  const remediation = await proposeRemediation({ alert, classification, context });

  // Safe remediations apply directly; risky ones wait for a human signal.
  let approved = !remediation.risky;
  if (remediation.risky) {
    setHandler(approveRemediation, () => {
      approved = true;
    });
    // Resolves immediately on the signal; otherwise times out after 12h and
    // `approved` stays false (the remediation is held, not applied).
    await condition(() => approved, "12h");
  }

  await notifyOutcome({ alert, remediation, approved });
}
