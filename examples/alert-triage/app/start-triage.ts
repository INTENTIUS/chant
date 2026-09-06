// Start a triage for an alert. Shared by both event sources (the webhook and
// the drift source).
//
// Staging the alert and running `chant run triage` is the whole of it: there
// is no client, no queue and no server, because an Op run is a process. What
// the run leaves behind is a record on the run ledger and, when it reaches the
// gate, a pending fact somebody answers with `chant approve`.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stageAlert } from "../activities/triage-state.js";
import type { Alert } from "../activities/triage.js";

const execFileAsync = promisify(execFile);

/** Exit 3 is `chant run`'s "reached a gate" (#2119), not a failure. */
const GATED_EXIT_CODE = 3;

export interface TriageStart {
  alert: Alert;
  /** True when the run stopped at `approve-remediation` rather than finishing. */
  gated: boolean;
}

export async function startTriage(alert: Alert): Promise<TriageStart> {
  stageAlert(alert);
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  try {
    await execFileAsync("chant", ["run", "triage"], { cwd });
    return { alert, gated: false };
  } catch (err) {
    if ((err as { code?: number }).code === GATED_EXIT_CODE) return { alert, gated: true };
    throw err;
  }
}

/** One line describing what a start did, for an event source to log or return. */
export function describeStart(start: TriageStart): string {
  return start.gated
    ? `triage ${start.alert.id} is waiting on approve-remediation — ` +
        `chant approve triage approve-remediation --approver you`
    : `triage ${start.alert.id} completed`;
}
