/**
 * The ports `chant components pr-env` runs ./pr-env-run.ts with: the records
 * on chant/lifecycle (`_pr-envs/records.jsonl`), the gate ledger there, and
 * the note and status on the forge. They sit apart from ./pr-env-run.ts
 * because the gate port loads ./pr-run.ts and ../op/gate.ts, which bring
 * Ajv, js-yaml and the component driver. A product with its own ports
 * imports `@intentius/chant/components/pr-env-run` and never loads these.
 */

import type { PrForge } from "../pr-forge";
import type { PrEnvPorts } from "./pr-env-run";
import {
  PR_ENV_LEDGER_DIR,
  PR_ENV_LEDGER_FILE,
  parsePrEnvRecords,
  prEnvNoteMarker,
  prEnvStatusContext,
  prEnvStatusDescription,
  prEnvStatusState,
  renderPrEnvNote,
  type PrEnvReport,
} from "./pr-environment";

/**
 * The note and the `chant/pr-env` status on the forge. A refusal from the
 * forge warns and never fails the run.
 */
export function forgePrEnvPublisher(forge: PrForge, warn: (message: string) => void = () => {}): (report: PrEnvReport) => Promise<void> {
  return async (report) => {
    const { forgePrincipalOf } = await import("../pr-forge");
    const note = renderPrEnvNote(report, forgePrincipalOf(forge.kind, forge.host, "<your-login>"));
    if (report.head) {
      try {
        await forge.setStatus(report.head, { context: prEnvStatusContext(report.member), state: prEnvStatusState(report), description: prEnvStatusDescription(report), ...(forge.runUrl ? { url: forge.runUrl } : {}) });
      } catch (err) {
        warn(`could not set the ${prEnvStatusContext(report.member)} status: ${messageOf(err)}`);
      }
    }
    try {
      await forge.upsertNote(report.pr, prEnvNoteMarker(report.env, report.member), note);
    } catch (err) {
      warn(`could not post the note on #${report.pr}: ${messageOf(err)}`);
    }
  };
}

/**
 * The ports over chant/lifecycle in `cwd` (default the working directory):
 * the records at `_pr-envs/records.jsonl`, appended and pushed, and the gate
 * ledger read without writing a pending fact. With `forge`, the note and
 * status are posted and the sweep asks it whether a pull request is open.
 */
export function lifecyclePrEnvPorts(opts: { cwd?: string; forge?: PrForge; log?: (line: string) => void; warn?: (message: string) => void } = {}): PrEnvPorts {
  const at = opts.cwd ? { cwd: opts.cwd } : undefined;
  const warn = opts.warn ?? (() => {});
  const forge = opts.forge;
  return {
    async readRecords() {
      const { fetchLifecycle, readBlobFromPath } = await import("../lifecycle/git");
      await fetchLifecycle(at).catch(() => false);
      return parsePrEnvRecords(await readBlobFromPath(PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE, at));
    },
    async appendRecord(record) {
      const { appendLedgerLine, fetchLifecycle, pushLifecycleReport } = await import("../lifecycle/git");
      try {
        await fetchLifecycle(at).catch(() => false);
        await appendLedgerLine(PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE, JSON.stringify(record), `Pull request environment ${record.env} ${record.kind} (${record.result})`, at);
        const pushed = await pushLifecycleReport(at);
        if (pushed.pushWarning) warn(pushed.pushWarning);
      } catch (err) {
        warn(`could not record ${record.env}'s ${record.kind} on chant/lifecycle: ${messageOf(err)}`);
      }
    },
    async decideGate(input) {
      const { approvalOf, decidePrGate, readOnlyLedger } = await import("./pr-run");
      const { gitGateLedgerPort } = await import("../op/gate");
      const approval = approvalOf(await decidePrGate(readOnlyLedger(gitGateLedgerPort(at)), input));
      return { status: approval.status, ...(approval.approvedBy ? { approvedBy: approval.approvedBy } : {}) };
    },
    ...(forge ? { publish: forgePrEnvPublisher(forge, warn) } : {}),
    ...(forge?.pullRequestState ? { pullRequestState: (pr: number) => forge.pullRequestState!(pr) } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    warn,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
