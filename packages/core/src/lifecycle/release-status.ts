/**
 * Release status records (#4596, terragucci#1289 bundle B): deprecate, yank
 * and restore a release, one line per change at
 * `<env>/release-status.jsonl`, beside the `releases.jsonl` it speaks about.
 *
 * The latest line per digest wins, so a restore is one more line with
 * `status: "active"` and nothing is ever rewritten. Any identity that may
 * publish may append one (ruling C, 2026-10-27): there is no approval gate,
 * and the record carries the actor and the reason instead.
 *
 * Writes go through `appendLedgerLine` (./git.ts), so they land under the
 * member prefix of `cwd` and honour `--no-record` (`CHANT_NO_RECORD`), as the
 * writers of #4551 do. Nothing here pushes: the caller runs
 * `pushLifecycleReport` after, the two-step shape every ledger here uses.
 *
 * The parse and the reads over a {@link LedgerReadPort} are pure. git is
 * loaded only by {@link appendReleaseStatus} and {@link readReleaseStatus},
 * so `chant query` (./query.ts) and a product bundle read the table without
 * it.
 */
import { NEXT_RELEASE } from "../release-floors";
import type { LedgerReadPort } from "./ledger-port";
import type { LedgerLocation } from "./git";
import type { CatalogStatusInput, ReleaseStatusValue } from "./release-catalog";

/** The first chant that writes and reads `<env>/release-status.jsonl`, and lists the `release_status` table (#4596). */
export const RELEASE_STATUS_FLOOR = NEXT_RELEASE;

/** The file a status record is appended to, in its environment's directory. */
export const RELEASE_STATUS_FILE = "release-status.jsonl";

/** The statuses a record may set. */
export const RELEASE_STATUSES = ["active", "deprecated", "yanked"] as const satisfies readonly ReleaseStatusValue[];

/** One status change for one release. */
export interface ReleaseStatusRecord {
  /** Schema version of the line. */
  version: 1;
  /** The component the release belongs to (`ReleaseRecord.component`). */
  component: string;
  /** The environment whose ledger holds the release, and this line. */
  env: string;
  /** The release's digest, the key the latest line is taken by. */
  digest: string;
  /** The release's version (`ReleaseRecord.releaseVersion`), when known. */
  releaseVersion?: string;
  /** `deprecated` and `yanked` mark the release; `active` restores it. */
  status: ReleaseStatusValue;
  /** Why, in the actor's words. */
  reason?: string;
  /** The version to move to instead. */
  replacement?: string;
  /** Who set it. */
  actor: string;
  /** ISO-8601 time it was set, given by the caller. */
  timestamp: string;
}

/** The fields a caller gives; `version` is filled in. */
export type ReleaseStatusInput = Omit<ReleaseStatusRecord, "version">;

/** A status record the reader would skip, so it is never appended. */
export class ReleaseStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseStatusError";
  }
}

const REQUIRED = ["component", "env", "digest", "actor", "timestamp"] as const;
const OPTIONAL = ["releaseVersion", "reason", "replacement"] as const;

/** Why `value` is not a status record, one line per problem; empty when it is one. */
export function releaseStatusProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["not an object"];
  const r = value as Record<string, unknown>;
  const problems: string[] = [];
  if (r.version !== 1) problems.push("version is not 1");
  for (const k of REQUIRED) if (typeof r[k] !== "string" || (r[k] as string).length === 0) problems.push(`${k} is missing`);
  for (const k of OPTIONAL) if (r[k] !== undefined && (typeof r[k] !== "string" || (r[k] as string).length === 0)) problems.push(`${k} is not a non-empty string`);
  if (!(RELEASE_STATUSES as readonly unknown[]).includes(r.status)) problems.push(`status is not one of ${RELEASE_STATUSES.join(", ")}`);
  return problems;
}

/** Parse a `release-status.jsonl` text, oldest first. A line that is not a record is counted and skipped. */
export function parseReleaseStatus(text: string | null): { records: ReleaseStatusRecord[]; malformed: number } {
  const records: ReleaseStatusRecord[] = [];
  let malformed = 0;
  for (const line of (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (releaseStatusProblems(parsed).length > 0) {
        malformed++;
        continue;
      }
      records.push(parsed as ReleaseStatusRecord);
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/**
 * The latest record per component and digest: the newest `timestamp`, ties
 * going to the later line. Keyed `<component>\0<digest>`; use
 * {@link statusOf} to look one up.
 */
export function latestReleaseStatus(records: readonly ReleaseStatusRecord[]): Map<string, ReleaseStatusRecord> {
  const latest = new Map<string, ReleaseStatusRecord>();
  for (const r of records) {
    const key = `${r.component}\u0000${r.digest}`;
    const cur = latest.get(key);
    if (!cur || r.timestamp >= cur.timestamp) latest.set(key, r);
  }
  return latest;
}

/**
 * The status of one release: the latest record for its component and
 * digest, or `active` with no record when none was ever set.
 */
export function statusOf(
  records: readonly ReleaseStatusRecord[],
  component: string,
  digest: string,
): { status: ReleaseStatusValue; record?: ReleaseStatusRecord } {
  const record = latestReleaseStatus(records).get(`${component}\u0000${digest}`);
  return record ? { status: record.status, record } : { status: "active" };
}

/** The records as the release catalog's status input (./release-catalog.ts). */
export function catalogStatusInputs(records: readonly ReleaseStatusRecord[]): CatalogStatusInput[] {
  return records.map((r) => ({
    component: r.component,
    digest: r.digest,
    ...(r.releaseVersion ? { version: r.releaseVersion } : {}),
    status: r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.replacement ? { replacement: r.replacement } : {}),
    actor: r.actor,
    timestamp: r.timestamp,
  }));
}

/** Every status record of `environment` the port holds, oldest first. */
export async function readReleaseStatusOn(port: LedgerReadPort, environment: string): Promise<{ records: ReleaseStatusRecord[]; malformed: number }> {
  return parseReleaseStatus(await port.read(environment, RELEASE_STATUS_FILE));
}

/**
 * Append one status record to `<env>/release-status.jsonl` under the member
 * prefix of `opts.cwd`. Refuses a record the reader would skip, before any
 * git runs. Does not push.
 */
export async function appendReleaseStatus(input: ReleaseStatusInput, opts?: { cwd?: string }): Promise<{ commit: string; record: ReleaseStatusRecord }> {
  const record: ReleaseStatusRecord = { version: 1, ...input };
  const problems = releaseStatusProblems(record);
  if (problems.length > 0) throw new ReleaseStatusError(`not a release status record: ${problems.join("; ")}`);
  const { appendLedgerLine } = await import("./git");
  const label = record.releaseVersion ?? record.digest;
  const commit = await appendLedgerLine(record.env, RELEASE_STATUS_FILE, JSON.stringify(record), `Release status: ${record.component} ${label} ${record.status}`, opts);
  return { commit, record };
}

/**
 * Every status record of `environment` on the local `chant/lifecycle`,
 * oldest first, for the member `location` resolves to. Never fetches.
 */
export async function readReleaseStatus(
  environment: string,
  location?: LedgerLocation,
): Promise<{ records: ReleaseStatusRecord[]; malformed: number }> {
  const { readBlobFromPath } = await import("./git");
  return parseReleaseStatus(await readBlobFromPath(environment, RELEASE_STATUS_FILE, location));
}
