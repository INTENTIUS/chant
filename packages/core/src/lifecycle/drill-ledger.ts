/**
 * The restore drill ledger (#5450): one line per drill at
 * `<env>/drills.jsonl` on `chant/lifecycle`, under the member's prefix in a
 * workspace. The record is `./drill-record.ts`'s. Appending follows the
 * run ledger's read-modify-write with a compare-and-set retry. Under
 * `--no-record` the write goes to the run's in-memory tip, as every ledger
 * write does.
 */

import { sortedJsonReplacer } from "../utils";
import { readBlobBySha, readBlobFromPath, readPathSha, RefCASConflictError, writeBlobToPath, type LedgerLocation } from "./git";
import { parseDrillLedger, type DrillRecord } from "./drill-record";

/** The ledger file under an environment's directory. */
export const DRILL_LEDGER_FILE = "drills.jsonl";

const APPEND_RETRY_ATTEMPTS = 5;

/** Every drill recorded for `env`, oldest first. Empty when none is. */
export async function readDrillLedger(env: string, opts?: LedgerLocation): Promise<{ records: DrillRecord[]; malformed: number }> {
  const text = await readBlobFromPath(env, DRILL_LEDGER_FILE, opts);
  return text ? parseDrillLedger(text) : { records: [], malformed: 0 };
}

/** Append one drill under the environment it names. Writes locally and does not push. Returns the ledger commit. */
export async function appendDrillRecord(record: DrillRecord, opts?: LedgerLocation): Promise<string> {
  const line = JSON.stringify(record, sortedJsonReplacer);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(record.env, DRILL_LEDGER_FILE, opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = `${existing ? `${existing.replace(/\n$/, "")}\n` : ""}${line}\n`;
      return await writeBlobToPath(record.env, DRILL_LEDGER_FILE, content, `Restore drill ${record.store}: ${record.outcome}`, {
        ...opts,
        expectPriorPathSha: priorSha,
      });
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
