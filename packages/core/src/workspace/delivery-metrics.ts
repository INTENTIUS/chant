/**
 * `chant workspace metrics [--env <env>] [--member <name>] [--since <date>] [--json]`
 * (#4039): the four DORA metrics per member and environment, from the deploy
 * records, the releases and their revocations on `chant/lifecycle`.
 *
 * The `--json` document is `delivery-metrics.schema.json`, a read-contract
 * output, so behold, a Grafana panel and terragucci's own estate read the
 * same numbers. The metrics are computed in `../lifecycle/delivery-metrics.ts`;
 * this module reads what they need:
 *
 * - each member's `<env>/releases.jsonl`, every environment it has, read in
 *   full, since deploys before the window decide lead times and deploys after
 *   a failure decide its restore;
 * - its releases, for the commit each was cut from, and the release gate's
 *   resolutions, for a deploy that names its release only through its
 *   admission (`releaseOfDeploy`, #4043);
 * - the counted `ci/revoked/<sha>` tags, judged as `release cut` judges them
 *   (`readRevokedCommits`, #4033), and each commit's committer time from git;
 *   a composed commit (#4168 4.3) takes the earliest time of the trunk
 *   commits it carries.
 *
 * Outside a workspace the project's own ledger is read as one member, `null`.
 * It reads the local branch and the local tags, and never fetches.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { DEFAULT_FAILURE_WINDOW_DAYS, environmentMetrics, type EnvironmentMetrics, type MetricsWindow } from "../lifecycle/delivery-metrics";
import type { LedgerLocation } from "../lifecycle/git";
import { findWorkspaceRoot } from "../project-root";
import { readDeclaration, readerVersion, WorkspaceReadError } from "./declaration";
import type { ReasonCode } from "./reason-codes";
import { gitTop, workingTree } from "./tree";
import { handToRootChant } from "./which-chant";

export const DELIVERY_METRICS_CONTRACT_VERSION = 1;
export const DELIVERY_METRICS_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/delivery-metrics/v1/delivery-metrics.schema.json";

/** The window when `--since` is not given: eight weeks back from now. */
export const DEFAULT_METRICS_DAYS = 56;

/** Why the read stopped. Closed. Outside a workspace there is no declaration to fail, so `declaration-missing` never comes back. */
export const METRICS_ERROR_CODES = [
  "declaration-ambiguous",
  "declaration-unparseable",
  "declaration-invalid",
  "placement-invalid",
  "reader-too-old",
  "root-chant-required",
  "not-a-git-repository",
  "environment-invalid",
] as const satisfies readonly ReasonCode[];
export type MetricsErrorCode = (typeof METRICS_ERROR_CODES)[number];

/** Why a member's metrics are missing or partial. Closed. */
export const METRICS_REASON_CODES = ["ledger-unreadable", "ledger-malformed"] as const satisfies readonly ReasonCode[];
export type MetricsReasonCode = (typeof METRICS_REASON_CODES)[number];

const ENV_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const USAGE = "chant workspace metrics [dir] [--env <env>] [--member <name>] [--since <date>] [--json]";

/** One member's metrics. */
export interface MemberMetrics {
  /** The member's name, or null for a project outside a workspace. */
  member: string | null;
  /** Each environment with a deploy ledger, sorted by name. */
  environments: EnvironmentMetrics[];
  /** Null when everything was read. */
  reason: { code: MetricsReasonCode; message: string } | null;
}

export type DeliveryMetricsDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      /** The workspace's name, or null for a project outside a workspace. */
      workspace: { name: string } | null;
      lifecycle: { ref: string; commit: string | null };
      window: MetricsWindow & { days: number };
      failureWindowDays: number;
      members: MemberMetrics[];
    }
  | { $schema: string; contract: number; chant: string; error: { code: MetricsErrorCode; message: string } };

export interface MetricsQuery {
  cwd: string;
  /** Only this environment. */
  env?: string;
  /** Only these members. */
  members?: string[];
  /** ISO-8601 date or time; the default is {@link DEFAULT_METRICS_DAYS} days before `now`. */
  since?: string;
  /** For tests: the end of the window. */
  now?: string;
}

class MetricsError extends Error {
  constructor(
    readonly code: MetricsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

/** Read the metrics document for the workspace or project holding `query.cwd`. */
export async function deliveryMetrics(query: MetricsQuery): Promise<DeliveryMetricsDocument> {
  const head = { $schema: DELIVERY_METRICS_SCHEMA_ID, contract: DELIVERY_METRICS_CONTRACT_VERSION, chant: readerVersion() };
  try {
    if (query.env !== undefined && (!ENV_PATTERN.test(query.env) || query.env.includes(".."))) {
      throw new MetricsError("environment-invalid", `--env ${JSON.stringify(query.env)} can't be an environment: use letters, digits, ".", "_" and "-", starting with a letter or digit`);
    }
    const top = gitTop(query.cwd);
    if (!top) throw new MetricsError("not-a-git-repository", `${query.cwd} is not in a git repository, so it has no chant/lifecycle branch to read`);

    const found = findWorkspaceRoot(query.cwd);
    const declaration = found ? readDeclaration(workingTree(found.dir), "", { rootChant: true }) : null;
    const root = found?.dir ?? query.cwd;
    const failureWindowDays = declaration?.metrics?.failureWindowDays ?? DEFAULT_FAILURE_WINDOW_DAYS;

    const until = query.now ?? new Date().toISOString();
    const since = query.since ?? new Date(Date.parse(until) - DEFAULT_METRICS_DAYS * 86_400_000).toISOString();
    const window = { since: new Date(Date.parse(since)).toISOString(), until: new Date(Date.parse(until)).toISOString() };
    const days = Math.round(((Date.parse(window.until) - Date.parse(window.since)) / 86_400_000) * 100) / 100;

    // The revoked commits, judged against ci.green at base (#4033). Tags that
    // can't be judged stop the read: the failure rate would be wrong otherwise.
    const { readRevokedCommits } = await import("../lifecycle/release-revocation");
    const revoked = await readRevokedCommits(root);

    const { compositionOf } = await import("../lifecycle/compose-refs");
    const commitTimes = new Map<string, number | null>();
    const ownTime = (sha: string): number | null => {
      const iso = tryGit(top, ["show", "-s", "--format=%cI", `${sha}^{commit}`]);
      return iso ? Date.parse(iso) : null;
    };
    const commitTime = (sha: string): number | null => {
      if (!commitTimes.has(sha)) {
        // #4168 4.3: a composed commit's lead time runs from the earliest trunk commit it carries.
        const sources = compositionOf(top, sha)?.sources ?? [];
        const times = sources.map(ownTime).filter((t): t is number => t !== null);
        commitTimes.set(sha, times.length > 0 ? Math.min(...times) : ownTime(sha));
      }
      return commitTimes.get(sha)!;
    };

    let ledgers: { member: string | null; loc: LedgerLocation }[];
    if (declaration) {
      const wanted = query.members && query.members.length > 0 ? new Set(query.members) : null;
      if (wanted) {
        const unknown = [...wanted].filter((n) => !declaration.members.some((m) => m.name === n));
        if (unknown.length > 0) throw new WorkspaceReadError("declaration-invalid", `--member ${unknown.join(", ")} names no member of the workspace`);
      }
      ledgers = declaration.members
        .filter((m) => !wanted || wanted.has(m.name))
        .map((m) => ({ member: m.name, loc: { cwd: root, member: m.dir === "." ? "." : m.name } }));
    } else {
      ledgers = [{ member: null, loc: { cwd: query.cwd } }];
    }

    const members: MemberMetrics[] = [];
    for (const l of ledgers) members.push(await memberMetrics(l.member, l.loc, { env: query.env, window, failureWindowDays, revoked, commitTime }));

    return {
      ...head,
      workspace: declaration ? { name: declaration.name } : null,
      lifecycle: { ref: "chant/lifecycle", commit: tryGit(top, ["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"]) || null },
      window: { ...window, days },
      failureWindowDays,
      members,
    };
  } catch (err) {
    if (err instanceof WorkspaceReadError) return { ...head, error: { code: err.code as MetricsErrorCode, message: err.message } };
    if (err instanceof MetricsError) return { ...head, error: { code: err.code, message: err.message } };
    throw err;
  }
}

async function memberMetrics(
  member: string | null,
  loc: LedgerLocation,
  ctx: {
    env: string | undefined;
    window: MetricsWindow;
    failureWindowDays: number;
    revoked: ReadonlyMap<string, { tag: string; tagged: string | null }>;
    commitTime: (sha: string) => number | null;
  },
): Promise<MemberMetrics> {
  try {
    const { listReleaseEnvironments, readReleaseLedger } = await import("../lifecycle/release-ledger");
    const { readAllReleases, readCuts, labelsByDigest } = await import("../lifecycle/release-store");
    const { readGateLedger } = await import("../lifecycle/gate-ledger");
    const { releaseOfDeploy } = await import("../lifecycle/release-join");
    const { RELEASE_GATE_OP } = await import("../op/gate-name");

    let envs = (await listReleaseEnvironments(loc)).sort();
    if (ctx.env !== undefined) envs = envs.filter((e) => e === ctx.env);
    if (envs.length === 0) return { member, environments: [], reason: null };

    const { releases, malformed: badReleases } = await readAllReleases(loc);
    const commits = new Map(releases.map((r) => [r.releaseDigest, r.commit]));
    const labels = labelsByDigest((await readCuts(loc)).cuts);
    const { resolutions } = await readGateLedger(RELEASE_GATE_OP, loc);

    const environments: EnvironmentMetrics[] = [];
    let badLines = 0;
    for (const env of envs) {
      const { records, malformed } = await readReleaseLedger(env, loc);
      badLines += malformed;
      environments.push(
        environmentMetrics(
          env,
          records,
          {
            releaseOf: (r) => releaseOfDeploy(r, resolutions),
            commitOfRelease: (d) => commits.get(d) ?? null,
            labelOf: (d) => labels.get(d) ?? null,
            revocationOf: (sha) => {
              const r = ctx.revoked.get(sha);
              return r ? { tag: r.tag, tagged: r.tagged } : null;
            },
            commitTime: ctx.commitTime,
          },
          ctx.window,
          ctx.failureWindowDays,
        ),
      );
    }
    const reason =
      badLines + badReleases > 0
        ? { code: "ledger-malformed" as const, message: `${badLines} deploy record line(s) and ${badReleases} release file(s) could not be read and are left out` }
        : null;
    return { member, environments, reason };
  } catch (err) {
    return { member, environments: [], reason: { code: "ledger-unreadable", message: `reading the ledger failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

const seconds = (s: number | null): string => {
  if (s === null) return "none";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round((s / 3600) * 10) / 10}h`;
  return `${Math.round((s / 86_400) * 10) / 10}d`;
};

/** The text view: one line per member and environment. */
export function formatMetrics(doc: Extract<DeliveryMetricsDocument, { members: unknown }>): string {
  const lines = [`window ${doc.window.since} to ${doc.window.until} (${doc.window.days} days), failure window ${doc.failureWindowDays} days`];
  for (const m of doc.members) {
    if (m.reason) lines.push(`${m.member ?? "."}: ${m.reason.code}: ${m.reason.message}`);
    for (const e of m.environments) {
      const rate = e.changeFailure.rate === null ? "-" : `${Math.round(e.changeFailure.rate * 1000) / 10}%`;
      lines.push(
        `${m.member ?? "."} ${e.env}: ${e.deployments.count} deploys (${e.deployments.perWeek}/week), lead time ${seconds(e.leadTime.medianSeconds)}, ` +
          `change failure ${rate} (${e.changeFailure.failed}/${e.changeFailure.deployments}), restore ${seconds(e.restore.medianSeconds)}` +
          (e.restore.open > 0 ? `, ${e.restore.open} open` : ""),
      );
    }
  }
  return lines.join("\n");
}

export async function runWorkspaceMetrics(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.since !== undefined && (args.since === "" || Number.isNaN(Date.parse(args.since)))) {
    console.error(formatError({ message: `--since ${JSON.stringify(args.since)} is not a date: give an ISO-8601 date such as 2026-09-01`, hint: USAGE }));
    return 1;
  }
  const cwd = resolve(args.extraPositional ?? ".");
  if (!existsSync(cwd)) {
    console.error(formatError({ message: `${cwd} does not exist`, hint: USAGE }));
    return 1;
  }
  const handed = await handToRootChant(cwd, undefined);
  if (handed !== undefined) return handed;
  const doc = await deliveryMetrics({ cwd, ...(args.env ? { env: args.env } : {}), ...(args.members ? { members: args.members } : {}), ...(args.since ? { since: args.since } : {}) });
  if (args.json) console.log(JSON.stringify(doc, null, 2));
  else if ("error" in doc) console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
  else console.log(formatMetrics(doc));
  return "error" in doc ? 1 : 0;
}
