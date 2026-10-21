/**
 * Applied-green records (#4168 step 9): the green commit apply on merge last
 * applied to an environment, kept on `chant/lifecycle` so the next apply
 * measures its change from there.
 *
 *   _green-applies/<env>.json    one record per environment, rewritten by each apply that finishes
 *
 * Apply on merge applies green commits, not each merge. `pr-apply --green`
 * plans at the green commit, measured from the one recorded here, and writes
 * this record once everything applied. A workspace member's record sits under
 * `_members/<member>/_green-applies/` through the same `ledgerDir` prefix the
 * merge records use.
 */

import { sortedJsonReplacer } from "../utils";
import { ledgerDir, readBlobFromPath, readPathSha, RefCASConflictError, writeLedgerFiles, type LedgerLocation } from "./git";

/** The directory on `chant/lifecycle` that holds applied-green records. */
export const GREEN_APPLIES_DIR = "_green-applies";

export const GREEN_APPLY_CONTRACT = 1;

export interface GreenApplyRecord {
  contract: number;
  env: string;
  member?: string;
  /** The green commit applied. */
  commit: string;
  /** The commit the change was measured from: the green commit applied before, or the first apply's base. */
  base: string;
  /** The change set's digest. */
  digest: string;
  /** `merges` when the merged changes' approvals covered the plan, `gate` when the combined plan was approved at its own gate. */
  approval: "merges" | "gate";
  approvedBy: string[];
  /** The first-parent commits from `base` (exclusive) to `commit`, oldest first. */
  merges: string[];
  appliedAt: string;
}

function recordFile(env: string): string {
  return `${env}.json`;
}

/** The last green commit applied to `env`, or null when none is recorded. Reads the local `chant/lifecycle` and never fetches. */
export async function readGreenApply(env: string, opts?: LedgerLocation): Promise<GreenApplyRecord | null> {
  const text = await readBlobFromPath(GREEN_APPLIES_DIR, recordFile(env), opts);
  if (text === null) return null;
  try {
    const doc = JSON.parse(text) as GreenApplyRecord;
    return doc?.contract === GREEN_APPLY_CONTRACT && typeof doc.commit === "string" ? doc : null;
  } catch {
    return null;
  }
}

/** Write `record` for its environment. Does not push: call `pushLifecycleReport` (./git.ts) after. */
export async function writeGreenApply(record: GreenApplyRecord, opts?: LedgerLocation): Promise<string> {
  const file = recordFile(record.env);
  const content = `${JSON.stringify(record, sortedJsonReplacer)}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await readPathSha(GREEN_APPLIES_DIR, file, opts);
    const dir = await ledgerDir(GREEN_APPLIES_DIR, opts);
    try {
      return await writeLedgerFiles([{ path: `${dir}/${file}`, content, expectPriorSha: prior }], `Applied green ${record.commit} to ${record.env}`, opts);
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
    }
  }
  throw new Error(`could not write the applied-green record for ${record.env}: chant/lifecycle kept moving`);
}
