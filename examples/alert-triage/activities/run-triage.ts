// The two halves of a triage, either side of the approval gate.
//
//   npx tsx activities/run-triage.ts propose    # classify, gather, propose
//   npx tsx activities/run-triage.ts apply      # apply the proposal, notify
//
// `ops/triage.op.ts` runs both, with `gate("approve-remediation")` between
// them. The proposal is written to `.chant/triage/current.json` so the second
// half acts on exactly what a person approved, not on a fresh classification
// that may have moved under them since.
//
// The alert itself comes from `.chant/triage/alert.json`, which the two event
// sources (app/webhook.ts, app/drift-source.ts) stage before they start a run.
// With nothing staged there — a bare `chant run triage` — a demo alert stands
// in, so the Op is runnable with nothing upstream of it.
import { existsSync } from "node:fs";
import {
  ALERT_FILE,
  PROPOSAL_FILE,
  readJson,
  writeJson,
  type Proposal,
} from "./triage-state.js";
import {
  applyRemediation,
  classifyAlert,
  gatherContext,
  notifyOutcome,
  proposeRemediation,
  type Alert,
} from "./triage.js";

const DEMO_ALERT: Alert = {
  id: "demo-alert",
  title: "API 5xx rate elevated in prod",
  body: "Error rate above 5% for 5m on service api.",
  source: "datadog",
};

async function propose(demo: boolean): Promise<void> {
  const staged = !demo && existsSync(ALERT_FILE);
  if (!staged) console.log("[alert-triage] no alert staged — triaging the demo alert");
  const alert = staged ? readJson<Alert>(ALERT_FILE) : DEMO_ALERT;

  const classification = await classifyAlert(alert);
  const context = await gatherContext(alert);
  const remediation = await proposeRemediation({ alert, classification, context });
  writeJson(PROPOSAL_FILE, { alert, classification, context, remediation });

  console.log(`[alert-triage] ${alert.id}: ${classification.severity} — ${classification.rationale}`);
  console.log(`[alert-triage] ${alert.id}: proposed — ${remediation.summary}`);
  console.log(
    `[alert-triage] ${alert.id}: ${remediation.risky ? "risky" : "routine"}; ` +
      `nothing is applied until approve-remediation resolves`,
  );
}

async function apply(): Promise<void> {
  const { alert, remediation } = readJson<Proposal>(PROPOSAL_FILE);
  await applyRemediation({ alert, remediation });
  await notifyOutcome({ alert, remediation, approved: true, applied: true });
}

const [step] = process.argv.slice(2);
const demo = process.argv.includes("--demo");

const run =
  step === "propose" ? propose(demo)
  : step === "apply" ? apply()
  : Promise.reject(new Error("usage: run-triage.ts <propose|apply> [--demo]"));

run.catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
