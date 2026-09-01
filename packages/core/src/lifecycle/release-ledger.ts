/**
 * Release ledger — the recorded half of build & deploy observability (#568,
 * epic #551 "Build & deploy observability").
 *
 * chant already has the *live-truth* half: ownership markers stamp stack/env
 * identity on live resources, `lifecycle diff --live` / `lifecycle plan`
 * compare declared vs live, and snapshots on `chant/lifecycle` give a
 * forensic timeline (see ./snapshot.ts, ./live-diff.ts, ./change-set.ts).
 * What was missing is the *record* half: "what we recorded deploying",
 * independent of whether the thing is still running.
 *
 * A release record is immutable and append-only: each deploy appends one line
 * to `<env>/releases.jsonl` on the `chant/lifecycle` orphan branch (see
 * ./git.ts's `appendReleaseRecord`/`readReleaseLedger`) — never rewritten,
 * never replaced in place, mirroring how the snapshot branch itself is
 * treated as observational evidence rather than a mutable state file. The
 * append-only property is what makes "which build was in staging on
 * Tuesday" answerable months later even after staging has moved on to a
 * dozen newer digests.
 *
 * The binding key is the artifact **digest** (`sha256:...`), the same
 * identity `BuildArchive` manifests and `publish-image`/`load-image-on-host`
 * promote by (see ../components/verbs/build-archive.ts,
 * ../components/verbs/publish.ts). Because publish promotes by digest never
 * rebuilding, the same identity threads build → dev → staging → prod, so
 * "which build is in prod, and is it the one tested in staging" is a
 * straightforward digest comparison over this ledger — never a guess through
 * CI logs.
 */

import { sortedJsonReplacer } from "../utils";
import { appendReleaseRecordLine, readReleaseLedgerLines, listLedgerEnvironments as gitListLedgerEnvironments } from "./git";

/**
 * The id space a `ReleaseRecord.runId` lives in, and how to reach the run
 * (#2045).
 */
export interface RunOrigin {
  /**
   * Which id space minted `runId`: `github` (a GitHub Actions run id — also
   * the spelling Forgejo Actions uses, since it implements the same env
   * contract; `url` disambiguates the actual host), `gitlab` (a CI pipeline
   * id), `op` (an orchestrator/Op run id), or `local` (minted on the machine
   * that ran the deploy, resolvable nowhere).
   */
  forge: "github" | "gitlab" | "op" | "local";
  /** Repo/project slug on the forge (`GITHUB_REPOSITORY` / `CI_PROJECT_PATH`), when the environment named one. */
  repo?: string;
  /** Resolved link to the run, when the environment provided enough to build one. */
  url?: string;
}

/**
 * One immutable deploy record: `(component, env, artifact digest, git sha,
 * run id, timestamp, actor)`, referencing the build archive by digest — the
 * exact shape epic #551 "Build & deploy observability" asks for.
 */
export interface ReleaseRecord {
  /** Schema version, so an incompatible future shape can be detected before being misread. */
  version: 1;
  /** Component this deploy released (matches `Component.name`, ../components/component.ts). */
  component: string;
  /** Environment this deploy targeted. */
  env: string;
  /**
   * Content-addressed digest of the promoted artifact (`sha256:...`) — the
   * same digest `publish-image`/`load-image-on-host` return
   * (`PublishImageOutput.digest`, ../components/verbs/publish.ts) and the
   * one `BuildArchiveManifest` entries carry
   * (../components/verbs/build-archive.ts). The join key for every query
   * this ledger answers.
   */
  digest: string;
  /** Git commit SHA the deploy was built from. */
  gitSha: string;
  /** Orchestrator run identifier (a `DriverRunResult`/Op run id, or a CI run id in generate mode) — the pointer back into the deploy event log. Which id space it lives in, and how to follow it, is `runOrigin`'s job (#2045). */
  runId: string;
  /**
   * Where `runId` can be resolved (#2045). A bare `runId` names a run in one
   * of several mutually incompatible id spaces — a GitHub Actions run id, a
   * GitLab pipeline id, an Op run id, a locally minted id — and without this
   * a reader can tell them apart only by inference from whoever wrote the
   * record. Written at record time from the same environment the id came
   * from, so the two cannot skew. Optional: records written before this
   * field existed, and callers passing an id whose origin they did not
   * declare, simply have none.
   */
  runOrigin?: RunOrigin;
  /**
   * When this record was written. The caller supplies this — the session
   * cannot call `Date.now()` reliably in every context, so the CLI resolves
   * a real `new Date()` at record time and passes it in as an ISO-8601
   * string; library code never defaults this internally.
   */
  timestamp: string;
  /** Who/what triggered the deploy (a username, a CI actor, a service account). */
  actor: string;
  /**
   * Who approved the change at its durable approval gate (#1035). Populated for
   * a gated change — the same identity the approver supplied when they cleared
   * the Temporal gate (`chant run signal ... --approver`, carried in the gate
   * signal payload and thus the workflow history). Optional and omitted for an
   * ungated change (nothing to approve), so `actor` alone answers "who made
   * it" while `approver` answers "who approved it" only where a gate exists.
   * Distinct from `actor`: the approver is deliberately a different person than
   * the one who triggered the deploy (separation of duties).
   */
  approver?: string;
  /** Optional: the archive's own manifest digest (../components/verbs/build-archive.ts's `manifestDigest`), when the caller has it — lets a reader recover full build contents/provenance, not just the promoted image digest. */
  manifestDigest?: string;
  /**
   * Optional: set when the deploy's capability-profile assertion (chant
   * #1244, helm lexicon) was deliberately overridden — carries the named
   * divergences that were bypassed (declared vs live), so the ledger shows
   * this release knowingly skewed from its declared profile. Absent for a
   * deploy whose target matched, and for deploys with no declared profile.
   */
  profileOverride?: string;
  /**
   * Optional: the deploy's input-side digest, when `digest` is a
   * rendered-content identity rather than an input identity. A pinned helm
   * deploy (chant #1242) records the render's `contentDigest` as `digest` —
   * what this cluster actually received — and carries the input digest
   * (chart, chart version, resolved values, capability facts; chant #1243)
   * here, because profiles are per cluster: two environments legitimately
   * render to different bytes, so cross-environment "is prod running what
   * staging tested" joins on this field while `digest` proves the exact
   * bytes each cluster got. Absent when `digest` is already input-side.
   */
  inputDigest?: string;
}

/** Required, non-empty-string fields every `ReleaseRecord` must carry. */
const REQUIRED_STRING_FIELDS: Array<keyof ReleaseRecord> = [
  "component",
  "env",
  "digest",
  "gitSha",
  "runId",
  "timestamp",
  "actor",
];

/** Thrown by `appendReleaseRecord` when the record is missing a required field — a release record can never be recorded partially, since it is never editable afterward. */
export class InvalidReleaseRecordError extends Error {
  constructor(public readonly missing: string[]) {
    super(`release record is missing required field(s): ${missing.join(", ")}`);
    this.name = "InvalidReleaseRecordError";
  }
}

/** Validate that a release record carries every required field as a non-empty string. */
export function validateReleaseRecord(record: Partial<ReleaseRecord>): string[] {
  const missing: string[] = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) missing.push(field);
  }
  return missing;
}

/** Input a caller supplies to record one deploy — `version` is filled in, everything else is required (see `ReleaseRecord`). */
export type ReleaseRecordInput = Omit<ReleaseRecord, "version">;

/**
 * Resolve a run id and its origin from the same environment, in one step, so
 * the two cannot skew (#2045). Resolution order mirrors what
 * `chant components release` always did — explicit id, then
 * `GITHUB_RUN_ID`, then `CI_PIPELINE_ID`, then a locally minted
 * `local-<ms>` — but now each source also names its id space:
 *
 *  - the GitHub path records `repo` (`GITHUB_REPOSITORY`) and builds the run
 *    `url` from `GITHUB_SERVER_URL` — which also makes a Forgejo instance's
 *    runs resolvable, since Forgejo Actions implements the same env contract;
 *  - the GitLab path records `repo` (`CI_PROJECT_PATH`) and takes
 *    `CI_PIPELINE_URL` verbatim;
 *  - the local mint says `local` in a field instead of only in the id's
 *    spelling.
 *
 * An explicit id still gets an origin when it matches the id the environment
 * itself is advertising (a CI job passing `--run-id $GITHUB_RUN_ID`);
 * otherwise the caller's id is recorded without one — guessing an origin the
 * caller did not state would be exactly the inference this field exists to
 * remove.
 */
export function resolveRunId(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): { runId: string; runOrigin?: RunOrigin } {
  const githubOrigin = (id: string): RunOrigin => ({
    forge: "github",
    ...(env.GITHUB_REPOSITORY ? { repo: env.GITHUB_REPOSITORY } : {}),
    ...(env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? { url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${id}` }
      : {}),
  });
  const gitlabOrigin = (): RunOrigin => ({
    forge: "gitlab",
    ...(env.CI_PROJECT_PATH ? { repo: env.CI_PROJECT_PATH } : {}),
    ...(env.CI_PIPELINE_URL ? { url: env.CI_PIPELINE_URL } : {}),
  });

  if (explicit) {
    if (env.GITHUB_RUN_ID && explicit === env.GITHUB_RUN_ID) return { runId: explicit, runOrigin: githubOrigin(explicit) };
    if (env.CI_PIPELINE_ID && explicit === env.CI_PIPELINE_ID) return { runId: explicit, runOrigin: gitlabOrigin() };
    return { runId: explicit };
  }
  if (env.GITHUB_RUN_ID) return { runId: env.GITHUB_RUN_ID, runOrigin: githubOrigin(env.GITHUB_RUN_ID) };
  if (env.CI_PIPELINE_ID) return { runId: env.CI_PIPELINE_ID, runOrigin: gitlabOrigin() };
  return { runId: `local-${Date.now()}`, runOrigin: { forge: "local" } };
}

/**
 * Append one immutable release record to the `<env>` ledger on the
 * `chant/lifecycle` orphan branch. Throws `InvalidReleaseRecordError` before
 * any git operation runs if a required field is missing — never partially
 * records, since nothing about a release record is editable after the fact.
 *
 * Does not push to the remote; call `pushLifecycle` (./git.ts) afterward, the
 * same two-step (`write` then `push`) shape `takeSnapshot` (./snapshot.ts)
 * uses, so a caller recording several releases in one run can batch the push.
 */
export async function appendReleaseRecord(
  input: ReleaseRecordInput,
  opts?: { cwd?: string },
): Promise<{ commit: string; record: ReleaseRecord }> {
  const missing = validateReleaseRecord(input);
  if (missing.length > 0) throw new InvalidReleaseRecordError(missing);

  const record: ReleaseRecord = { version: 1, ...input };
  const json = JSON.stringify(record, sortedJsonReplacer);
  const commit = await appendReleaseRecordLine(record.env, json, opts);
  return { commit, record };
}

/**
 * Read every release record for `environment`, oldest first. Malformed lines
 * (a hand-edited or corrupted ledger) are skipped rather than throwing, since
 * a status query should degrade gracefully rather than fail outright on one
 * bad line — but each skip is reported so callers/tests can surface it.
 */
export async function readReleaseLedger(
  environment: string,
  opts?: { cwd?: string },
): Promise<{ records: ReleaseRecord[]; malformed: number }> {
  const lines = await readReleaseLedgerLines(environment, opts);
  const records: ReleaseRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ReleaseRecord;
      if (validateReleaseRecord(parsed).length > 0) {
        malformed++;
        continue;
      }
      records.push(parsed);
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/** List every environment that has release records on the orphan branch. */
export async function listReleaseEnvironments(opts?: { cwd?: string }): Promise<string[]> {
  return gitListLedgerEnvironments(opts);
}

/**
 * The latest release record per component in `records` — "what we recorded
 * deploying" reduces to one row per component by taking the most recent
 * `timestamp` (ties broken by ledger order, i.e. later append wins), since
 * a component may have many historical records in one environment's ledger.
 */
export function latestPerComponent(records: ReleaseRecord[]): Map<string, ReleaseRecord> {
  const latest = new Map<string, ReleaseRecord>();
  for (const record of records) {
    const current = latest.get(record.component);
    if (!current || record.timestamp >= current.timestamp) {
      latest.set(record.component, record);
    }
  }
  return latest;
}

/**
 * Find every release record across `records` that references `digest` — the
 * cross-environment query "is the build in prod the one tested in staging"
 * reduces to: read both envs' ledgers, then check whether the same digest
 * appears in each. Sorted oldest first, matching ledger order.
 */
export function recordsForDigest(records: ReleaseRecord[], digest: string): ReleaseRecord[] {
  return records.filter((r) => r.digest === digest);
}
