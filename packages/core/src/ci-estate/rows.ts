/**
 * The ledger rows the estate reads (#4612), read once from the tables of
 * the read contract (`../lifecycle/query.ts`): `runs`, `gates`, `applies`
 * and `pr_envs`. Every reader in this directory takes the same
 * {@link EstateRows}, so a Terraform member and a Pulumi member go through
 * one code path: both apply through `chant run wave`, whose job writes one
 * run record with its `wave` field (#4551), and both record drift as a run
 * whose `Drift` outcome says what it found.
 *
 * Nothing here reads git or a bucket. The caller loads the tables with
 * `loadQueryData` (or {@link readEstateLedger} in ../ci-estate.ts), or
 * builds them by hand in a test.
 */
import type { QueryData, QueryRow } from "../lifecycle/query";
import { opRunWaveOf, type OpRunWave } from "../op/runtime";

/** The tables the estate reads. A full `QueryData` is one. */
export type EstateTables = Pick<QueryData, "runs" | "gates" | "applies" | "pr_envs">;

/** How the rows are read. */
export interface EstateRowOptions {
  /** The name of a ledger read outside a workspace, whose rows have `member` NULL. Default `default`. */
  project?: string;
  /**
   * Ops whose runs are drift checks. Default: a run whose labels carry
   * `Watch=true` (a WatchOp) or whose outcomes carry a boolean `Drift`.
   */
  driftOps?: readonly string[];
  /**
   * Ops whose plain runs (not op wave jobs) count as applies: an `ok` run
   * applied, a `fail` run failed. Default none, since an op wave job already
   * records each apply with its targets.
   */
  deployOps?: readonly string[];
}

/** One op wave job that applied or tried to, from its run record. */
export interface WaveJob {
  member: string;
  id: string;
  spec: string;
  wave: number;
  name: string;
  job: OpRunWave["job"];
  share?: number;
  group?: string;
  digest?: string;
  status: string;
  started: string;
  ended: string;
  commit?: string;
  runUrl?: string;
  applied: string[];
  failed: string[];
  moved: string[];
  blocked: string[];
  outcome?: OpRunWave["outcome"];
  /** The gate the job waited at, when it did. */
  gate?: string;
}

/** One drift check, from its run record. */
export interface DriftRun {
  member: string;
  id: string;
  op: string;
  status: string;
  started: string;
  ended: string;
  /** What the check found: `true` drift, `false` none, undefined when it says nothing (a failed check). */
  drifted?: boolean;
  /** The roots or stacks it found drifted, from a `DriftedRoots` outcome; empty means any of the member's. */
  roots: string[];
  commit?: string;
  runUrl?: string;
}

/** A gate ledger line. */
export interface GateLine {
  member: string;
  op: string;
  gate: string;
  kind: "pending" | "resolution";
  timestamp: string;
  planDigest?: string;
  resolvedBy?: string;
  commit?: string;
}

/** An apply under an approval, from `_gates/<op>/applied.jsonl`. */
export interface ApprovedApply {
  member: string;
  op: string;
  gate: string;
  planDigest: string;
  approvedAt: string;
  approvedBy?: string;
  timestamp: string;
  result?: string;
}

/** A pull request environment line. */
export interface PrEnvLine {
  member: string;
  kind: "up" | "down";
  pr: number;
  env: string;
  result?: string;
  commit?: string;
  timestamp: string;
  expiresAt?: string;
  runUrl?: string;
}

/** The rows, read. */
export interface EstateRows {
  members: string[];
  waves: WaveJob[];
  drift: DriftRun[];
  gates: GateLine[];
  approved: ApprovedApply[];
  prEnvs: PrEnvLine[];
}

const str = (v: QueryRow[string] | undefined): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function parsed(v: QueryRow[string] | undefined): unknown {
  if (typeof v !== "string") return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The member a row belongs to: the member whose root it applied when the run names one, else the ledger's. */
function memberOf(row: QueryRow, project: string): string {
  return str(row.root_member) ?? str(row.member) ?? project;
}

/** Whether a run is a drift check. */
function isDrift(row: QueryRow, driftOps: readonly string[] | undefined): boolean {
  if (driftOps) return driftOps.includes(String(row.op));
  const labels = record(parsed(row.labels));
  const outcomes = record(parsed(row.outcomes));
  return labels.Watch === "true" || typeof outcomes.Drift === "boolean";
}

/** Read the tables into the shapes the estate uses. Malformed JSON cells read as absent. */
export function estateRows(tables: EstateTables, options: EstateRowOptions = {}): EstateRows {
  const project = options.project ?? "default";
  const waves: WaveJob[] = [];
  const drift: DriftRun[] = [];
  for (const r of tables.runs) {
    const member = memberOf(r, project);
    const started = str(r.started) ?? "";
    const ended = str(r.ended) ?? started;
    const status = str(r.status) ?? "fail";
    const at = { ...(str(r.git_sha) ? { commit: str(r.git_sha)! } : {}), ...(str(r.run_url) ? { runUrl: str(r.run_url)! } : {}) };
    const wave = opRunWaveOf(parsed(r.wave));
    if (wave) {
      if (wave.job === "decide") {
        // A deciding job applies nothing; its time is when the wave was first planned.
        waves.push({ member, id: String(r.id), spec: wave.spec, wave: wave.number, name: wave.name, job: wave.job, ...(wave.digest ? { digest: wave.digest } : {}), status, started, ended, ...at, applied: [], failed: [], moved: [], blocked: [] });
        continue;
      }
      waves.push({
        member,
        id: String(r.id),
        spec: wave.spec,
        wave: wave.number,
        name: wave.name,
        job: wave.job,
        ...(wave.share !== undefined ? { share: wave.share } : {}),
        ...(wave.group !== undefined ? { group: wave.group } : {}),
        ...(wave.digest ? { digest: wave.digest } : {}),
        status,
        started,
        ended,
        ...at,
        applied: [...wave.applied],
        failed: [...wave.failed],
        moved: [...wave.moved],
        blocked: Object.keys(wave.blocked ?? {}),
        ...(wave.outcome ? { outcome: wave.outcome } : {}),
        ...(str(r.gate) ? { gate: str(r.gate)! } : {}),
      });
      continue;
    }
    if (isDrift(r, options.driftOps)) {
      const outcomes = record(parsed(r.outcomes));
      drift.push({
        member,
        id: String(r.id),
        op: String(r.op),
        status,
        started,
        ended,
        ...(typeof outcomes.Drift === "boolean" ? { drifted: outcomes.Drift } : {}),
        roots: strings(outcomes.DriftedRoots),
        ...at,
      });
      continue;
    }
    if (options.deployOps?.includes(String(r.op)) && (status === "ok" || status === "fail")) {
      // A plain apply Op: one target, the member's root.
      const target = str(r.root_member) ?? String(r.op);
      waves.push({ member, id: String(r.id), spec: String(r.op), wave: 1, name: String(r.op), job: "wave", status, started, ended, ...at, applied: status === "ok" ? [target] : [], failed: status === "fail" ? [target] : [], moved: [], blocked: [] });
    }
  }
  const gates: GateLine[] = tables.gates.map((g) => ({
    member: memberOf(g, project),
    op: String(g.op),
    gate: String(g.gate),
    kind: g.kind === "pending" ? "pending" : "resolution",
    timestamp: str(g.timestamp) ?? "",
    ...(str(g.plan_digest) ? { planDigest: str(g.plan_digest)! } : {}),
    ...(str(g.resolved_by) ? { resolvedBy: str(g.resolved_by)! } : {}),
    ...(str(g.git_sha) ? { commit: str(g.git_sha)! } : {}),
  }));
  const approved: ApprovedApply[] = tables.applies
    .filter((a) => str(a.plan_digest) && str(a.approved_at))
    .map((a) => ({
      member: memberOf(a, project),
      op: String(a.op),
      gate: String(a.gate),
      planDigest: str(a.plan_digest)!,
      approvedAt: str(a.approved_at)!,
      ...(str(a.approved_by) ? { approvedBy: str(a.approved_by)! } : {}),
      timestamp: str(a.timestamp) ?? str(a.approved_at)!,
      ...(str(a.result) ? { result: str(a.result)! } : {}),
    }));
  const prEnvs: PrEnvLine[] = tables.pr_envs
    .filter((p) => (p.kind === "up" || p.kind === "down") && typeof p.pr === "number")
    .map((p) => ({
      member: str(p.env_member) ?? memberOf(p, project),
      kind: p.kind as "up" | "down",
      pr: p.pr as number,
      env: String(p.env),
      ...(str(p.result) ? { result: str(p.result)! } : {}),
      ...(str(p.git_sha) ? { commit: str(p.git_sha)! } : {}),
      timestamp: str(p.timestamp) ?? "",
      ...(str(p.expires_at) ? { expiresAt: str(p.expires_at)! } : {}),
      ...(str(p.run_url) ? { runUrl: str(p.run_url)! } : {}),
    }));
  const members = [...new Set([...waves, ...drift, ...gates, ...approved, ...prEnvs].map((x) => x.member))].sort();
  return { members, waves, drift, gates, approved, prEnvs };
}
