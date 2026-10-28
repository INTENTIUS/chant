/**
 * The append and read of `_pr-envs/records.jsonl` (#4551), the ledger of
 * pull request environments, for a product that applies or tears one down
 * itself (terragucci's ephemeral copies). It imports only the git layer and
 * the record parser, so a product bundle loads no Ajv and no component
 * driver.
 *
 * Each write goes under the member prefix of `cwd` and honours `--no-record`
 * through `../lifecycle/git.ts`. Neither function pushes: call
 * `pushLifecycleReport` after, the two-step shape every ledger here uses.
 */
import { appendLedgerLine, readBlobFromPath, type LedgerLocation } from "../lifecycle/git";
import { PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE, parsePrEnvRecords, type PrEnvRecord } from "./pr-environment";

/** The first chant that exports {@link appendPrEnvRecord} and {@link readPrEnvRecords} (#4551). */
export const PR_ENV_APPEND_FLOOR = "0.124.55";

/** A record {@link parsePrEnvRecords} would skip, so it is never appended. */
export class PrEnvRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrEnvRecordError";
  }
}

/**
 * Append one record to `_pr-envs/records.jsonl` under the member prefix of
 * `opts.cwd`. Refuses a record the reader would skip. Does not push.
 */
export async function appendPrEnvRecord(record: PrEnvRecord, opts?: { cwd?: string }): Promise<{ commit: string; record: PrEnvRecord }> {
  const line = JSON.stringify(record);
  if (parsePrEnvRecords(line).length !== 1) {
    throw new PrEnvRecordError(`not a pull request environment record: it needs version 1, kind up or down, a numeric pr, env and marker.stack`);
  }
  const commit = await appendLedgerLine(PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE, line, `Pull request environment ${record.env} ${record.kind} (${record.result})`, opts);
  return { commit, record };
}

/** Every record in `_pr-envs/records.jsonl`, oldest first. Reads the local branch and never fetches. */
export async function readPrEnvRecords(location?: LedgerLocation): Promise<PrEnvRecord[]> {
  return parsePrEnvRecords(await readBlobFromPath(PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE, location));
}
