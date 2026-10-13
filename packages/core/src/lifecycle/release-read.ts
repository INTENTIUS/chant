/**
 * Reading release records without git (#3865). The parsing and the
 * environment listing of `release-ledger.ts`, over a {@link LedgerReadPort}
 * instead of a checkout, so a product bundles them in one file
 * (`release-read-bundle.test.ts` holds the import graph). Pass
 * `gitLedgerReadPort({ member })` from `./git.ts` to read a workspace member's
 * ledger from a checkout, or a port of your own.
 *
 * `release-ledger.ts` reads through these too; its `readReleaseLedger` and
 * `listReleaseEnvironments` also take `member` or `ledgerPrefix`.
 */
import { flagLegacyDigest } from "./legacy-digest";
import type { LedgerReadPort } from "./ledger-port";
import type { ReleaseRecord } from "./release-ledger";

/** Required, non-empty-string fields every `ReleaseRecord` must carry. */
const REQUIRED_STRING_FIELDS: Array<keyof ReleaseRecord> = ["component", "env", "digest", "gitSha", "runId", "timestamp", "actor"];

/** The required fields a release record lacks as non-empty strings. */
export function validateReleaseRecord(record: Partial<ReleaseRecord>): string[] {
  const missing: string[] = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) missing.push(field);
  }
  return missing;
}

/** The lines of a `releases.jsonl` file: trimmed, blanks dropped. */
export function releaseLedgerLines(text: string | null): string[] {
  return text ? text.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

/**
 * Parse release ledger lines, oldest first. A malformed line is counted and
 * skipped; a digest recorded by the old 32-bit hash reads back flagged
 * (#2514), never re-keyed.
 */
export function parseReleaseLedger(lines: readonly string[]): { records: ReleaseRecord[]; malformed: number } {
  const records: ReleaseRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ReleaseRecord;
      if (parsed === null || typeof parsed !== "object" || validateReleaseRecord(parsed).length > 0) {
        malformed++;
        continue;
      }
      records.push(flagLegacyDigest(parsed, [parsed.digest, parsed.manifestDigest, parsed.inputDigest]));
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/** Every release record of `environment` the port holds, oldest first. */
export async function readReleaseRecords(port: LedgerReadPort, environment: string): Promise<{ records: ReleaseRecord[]; malformed: number }> {
  return parseReleaseLedger(releaseLedgerLines(await port.read(environment, "releases.jsonl")));
}

/** The environments with a `releases.jsonl`, sorted: the port's root directories that hold one. */
export async function listReleaseEnvironmentsOn(port: LedgerReadPort): Promise<string[]> {
  const envs: string[] = [];
  for (const name of await port.trees()) {
    if (await port.read(name, "releases.jsonl")) envs.push(name);
  }
  return envs.sort();
}
