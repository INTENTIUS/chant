/**
 * The stores a restore drill can restore (#5450): for each kind, how to find
 * the newest backup, restore it into a scratch environment and tear that
 * environment down. Every call goes through an injected {@link DrillExec}, so
 * a test answers the commands with a fake and nothing here touches a cloud.
 *
 * The commands are the `aws`, `velero` and `kubectl` CLIs, run as an
 * argument list (never through a shell). An emulator is reached the way the
 * CLI reaches one: `AWS_ENDPOINT_URL` in the environment the Op runs in.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

/** Runs one command and returns its stdout; rejects when it exits non-zero, with its stderr in the message. */
export type DrillExec = (argv: readonly string[], opts?: { env?: Record<string, string> }) => Promise<{ stdout: string }>;

/** The default {@link DrillExec}: `execFile`, with `env` added to this process's environment. */
export const defaultDrillExec: DrillExec = async (argv, opts) => {
  const [file, ...args] = argv;
  try {
    const { stdout } = await execFileAsync(file, args, { env: { ...process.env, ...opts?.env }, maxBuffer: 256 * 1024 * 1024 });
    return { stdout };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`${argv.slice(0, 3).join(" ")}: ${(e.stderr || e.message || String(err)).trim().split("\n").slice(-3).join(" ")}`);
  }
};

/** A store to drill, as an Op declares it. `name` is the key the drill is recorded and reported under. */
export type DrillStoreSpec =
  | { kind: "rds"; name: string; instance: string }
  | { kind: "aurora"; name: string; cluster: string; engine: string; instanceClass: string }
  | { kind: "dynamodb"; name: string; table: string }
  | { kind: "s3"; name: string; bucket: string; prefix?: string }
  | { kind: "velero"; name: string; namespace: string; schedule?: string };

/** The backup a drill restores. `at` is an ISO-8601 instant: the point in time the backup holds. */
export interface DrillBackup {
  id: string;
  at: string;
}

/** What a restore made: the endpoint checks reach it at, when it has one. */
export interface DrillRestored {
  endpoint?: string;
}

export interface DrillAdapter {
  /** The newest usable backup. Throws when the store has none. */
  newestBackup(): Promise<DrillBackup>;
  /** Restore into `scratch` and return once the restored store is available. */
  restore(backup: DrillBackup, scratch: string): Promise<DrillRestored>;
  /** Remove `scratch` and what the restore put in it. Safe to call when the restore stopped part way, or never started. */
  teardown(scratch: string): Promise<void>;
}

/** The identifiers in the source store a scratch name must not equal. */
export function sourceNames(spec: DrillStoreSpec): string[] {
  switch (spec.kind) {
    case "rds": return [spec.instance];
    case "aurora": return [spec.cluster];
    case "dynamodb": return [spec.table];
    case "s3": return [spec.bucket];
    case "velero": return [spec.namespace];
  }
}

const json = (stdout: string, what: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${what}: the command did not print JSON`);
  }
};

/** An ISO instant from what the aws CLI prints: an ISO string, or epoch seconds. */
export function isoOf(value: unknown, what: string): string {
  const t = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) throw new Error(`${what}: ${JSON.stringify(value)} is not a time`);
  return new Date(t).toISOString();
}

const MISSING = /NotFound|not found|NoSuchBucket|does not exist|ResourceNotFoundException|AlreadyDeleted/i;

/** Run a teardown command, accepting that the thing is already gone. */
async function remove(exec: DrillExec, argv: readonly string[]): Promise<void> {
  try {
    await exec(argv);
  } catch (err) {
    if (!MISSING.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}

type Row = Record<string, unknown>;
const rows = (v: unknown, key: string): Row[] => {
  const list = typeof v === "object" && v !== null ? (v as Row)[key] : undefined;
  return Array.isArray(list) ? (list as Row[]) : [];
};
const newest = <T>(items: T[], at: (t: T) => string, none: string): T => {
  if (items.length === 0) throw new Error(none);
  return items.reduce((a, b) => (Date.parse(at(b)) > Date.parse(at(a)) ? b : a));
};

function rdsAdapter(spec: Extract<DrillStoreSpec, { kind: "rds" }>, exec: DrillExec): DrillAdapter {
  return {
    async newestBackup() {
      const out = json((await exec(["aws", "rds", "describe-db-snapshots", "--db-instance-identifier", spec.instance, "--output", "json"])).stdout, "describe-db-snapshots");
      const ready = rows(out, "DBSnapshots").filter((s) => s.Status === "available" && s.SnapshotCreateTime !== undefined);
      const s = newest(ready, (r) => isoOf(r.SnapshotCreateTime, "SnapshotCreateTime"), `no available snapshot of RDS instance ${spec.instance}`);
      return { id: String(s.DBSnapshotIdentifier), at: isoOf(s.SnapshotCreateTime, "SnapshotCreateTime") };
    },
    async restore(backup, scratch) {
      await exec(["aws", "rds", "restore-db-instance-from-db-snapshot", "--db-instance-identifier", scratch, "--db-snapshot-identifier", backup.id, "--no-publicly-accessible"]);
      await exec(["aws", "rds", "wait", "db-instance-available", "--db-instance-identifier", scratch]);
      const out = json((await exec(["aws", "rds", "describe-db-instances", "--db-instance-identifier", scratch, "--output", "json"])).stdout, "describe-db-instances");
      const ep = (rows(out, "DBInstances")[0]?.Endpoint ?? {}) as Row;
      return ep.Address ? { endpoint: ep.Port ? `${ep.Address}:${ep.Port}` : String(ep.Address) } : {};
    },
    async teardown(scratch) {
      await remove(exec, ["aws", "rds", "delete-db-instance", "--db-instance-identifier", scratch, "--skip-final-snapshot", "--delete-automated-backups"]);
    },
  };
}

function auroraAdapter(spec: Extract<DrillStoreSpec, { kind: "aurora" }>, exec: DrillExec): DrillAdapter {
  const member = (scratch: string) => `${scratch}-1`;
  return {
    async newestBackup() {
      const out = json((await exec(["aws", "rds", "describe-db-cluster-snapshots", "--db-cluster-identifier", spec.cluster, "--output", "json"])).stdout, "describe-db-cluster-snapshots");
      const ready = rows(out, "DBClusterSnapshots").filter((s) => s.Status === "available" && s.SnapshotCreateTime !== undefined);
      const s = newest(ready, (r) => isoOf(r.SnapshotCreateTime, "SnapshotCreateTime"), `no available snapshot of Aurora cluster ${spec.cluster}`);
      return { id: String(s.DBClusterSnapshotIdentifier), at: isoOf(s.SnapshotCreateTime, "SnapshotCreateTime") };
    },
    async restore(backup, scratch) {
      await exec(["aws", "rds", "restore-db-cluster-from-snapshot", "--db-cluster-identifier", scratch, "--snapshot-identifier", backup.id, "--engine", spec.engine]);
      await exec(["aws", "rds", "create-db-instance", "--db-instance-identifier", member(scratch), "--db-cluster-identifier", scratch, "--db-instance-class", spec.instanceClass, "--engine", spec.engine, "--no-publicly-accessible"]);
      await exec(["aws", "rds", "wait", "db-instance-available", "--db-instance-identifier", member(scratch)]);
      const out = json((await exec(["aws", "rds", "describe-db-clusters", "--db-cluster-identifier", scratch, "--output", "json"])).stdout, "describe-db-clusters");
      const c = rows(out, "DBClusters")[0] ?? {};
      return c.Endpoint ? { endpoint: c.Port ? `${c.Endpoint}:${c.Port}` : String(c.Endpoint) } : {};
    },
    async teardown(scratch) {
      await remove(exec, ["aws", "rds", "delete-db-instance", "--db-instance-identifier", member(scratch), "--skip-final-snapshot"]);
      try {
        await exec(["aws", "rds", "wait", "db-instance-deleted", "--db-instance-identifier", member(scratch)]);
      } catch (err) {
        if (!MISSING.test(err instanceof Error ? err.message : String(err))) throw err;
      }
      await remove(exec, ["aws", "rds", "delete-db-cluster", "--db-cluster-identifier", scratch, "--skip-final-snapshot"]);
    },
  };
}

function dynamodbAdapter(spec: Extract<DrillStoreSpec, { kind: "dynamodb" }>, exec: DrillExec): DrillAdapter {
  return {
    async newestBackup() {
      const out = json((await exec(["aws", "dynamodb", "describe-continuous-backups", "--table-name", spec.table, "--output", "json"])).stdout, "describe-continuous-backups");
      const pitr = ((out as Row).ContinuousBackupsDescription as Row | undefined)?.PointInTimeRecoveryDescription as Row | undefined;
      if (pitr?.PointInTimeRecoveryStatus !== "ENABLED" || pitr.LatestRestorableDateTime === undefined) {
        throw new Error(`DynamoDB table ${spec.table} has no point-in-time recovery to restore from`);
      }
      return { id: "point-in-time", at: isoOf(pitr.LatestRestorableDateTime, "LatestRestorableDateTime") };
    },
    async restore(backup, scratch) {
      await exec(["aws", "dynamodb", "restore-table-to-point-in-time", "--source-table-name", spec.table, "--target-table-name", scratch, "--restore-date-time", backup.at]);
      await exec(["aws", "dynamodb", "wait", "table-exists", "--table-name", scratch]);
      return {};
    },
    async teardown(scratch) {
      await remove(exec, ["aws", "dynamodb", "delete-table", "--table-name", scratch]);
    },
  };
}

function s3Adapter(spec: Extract<DrillStoreSpec, { kind: "s3" }>, exec: DrillExec): DrillAdapter {
  const prefix = spec.prefix ?? "";
  return {
    async newestBackup() {
      const out = json((await exec(["aws", "s3api", "list-object-versions", "--bucket", spec.bucket, "--prefix", prefix, "--output", "json"])).stdout, "list-object-versions");
      const current = rows(out, "Versions").filter((v) => v.IsLatest === true && v.LastModified !== undefined);
      const v = newest(current, (r) => isoOf(r.LastModified, "LastModified"), `no object versions under s3://${spec.bucket}/${prefix}`);
      return { id: `${spec.bucket}/${prefix}@${String(v.VersionId ?? "null")}`, at: isoOf(v.LastModified, "LastModified") };
    },
    async restore(_backup, scratch) {
      await exec(["aws", "s3", "mb", `s3://${scratch}`]);
      await exec(["aws", "s3", "sync", `s3://${spec.bucket}/${prefix}`, `s3://${scratch}/`, "--only-show-errors"]);
      return { endpoint: `s3://${scratch}` };
    },
    async teardown(scratch) {
      await remove(exec, ["aws", "s3", "rb", `s3://${scratch}`, "--force"]);
    },
  };
}

function veleroAdapter(spec: Extract<DrillStoreSpec, { kind: "velero" }>, exec: DrillExec): DrillAdapter {
  return {
    async newestBackup() {
      const out = json((await exec(["velero", "backup", "get", "-o", "json"])).stdout, "velero backup get");
      const list = Array.isArray((out as Row).items) ? rows(out, "items") : [out as Row];
      const ready = list.filter((b) => {
        const status = (b.status ?? {}) as Row;
        const meta = (b.metadata ?? {}) as Row;
        const included = (((b.spec ?? {}) as Row).includedNamespaces ?? ["*"]) as unknown[];
        const labels = (meta.labels ?? {}) as Row;
        return (
          status.phase === "Completed" &&
          status.startTimestamp !== undefined &&
          (included.length === 0 || included.includes("*") || included.includes(spec.namespace)) &&
          (spec.schedule === undefined || labels["velero.io/schedule-name"] === spec.schedule)
        );
      });
      const b = newest(ready, (r) => isoOf(((r.status ?? {}) as Row).startTimestamp, "startTimestamp"), `no completed Velero backup of namespace ${spec.namespace}${spec.schedule ? ` from schedule ${spec.schedule}` : ""}`);
      return { id: String(((b.metadata ?? {}) as Row).name), at: isoOf(((b.status ?? {}) as Row).startTimestamp, "startTimestamp") };
    },
    async restore(backup, scratch) {
      await exec(["velero", "restore", "create", scratch, "--from-backup", backup.id, "--namespace-mappings", `${spec.namespace}:${scratch}`, "--wait"]);
      const out = json((await exec(["velero", "restore", "get", scratch, "-o", "json"])).stdout, "velero restore get") as Row;
      const phase = ((out.status ?? {}) as Row).phase;
      if (phase !== "Completed") throw new Error(`Velero restore ${scratch} ended ${String(phase)}, not Completed`);
      return {};
    },
    async teardown(scratch) {
      await remove(exec, ["kubectl", "delete", "namespace", scratch, "--ignore-not-found", "--wait=true"]);
      await remove(exec, ["velero", "restore", "delete", scratch, "--confirm"]);
    },
  };
}

/** The adapter for a store, over `exec`. */
export function drillAdapterFor(spec: DrillStoreSpec, exec: DrillExec = defaultDrillExec): DrillAdapter {
  switch (spec.kind) {
    case "rds": return rdsAdapter(spec, exec);
    case "aurora": return auroraAdapter(spec, exec);
    case "dynamodb": return dynamodbAdapter(spec, exec);
    case "s3": return s3Adapter(spec, exec);
    case "velero": return veleroAdapter(spec, exec);
    default: throw new Error(`restore drill: unknown store kind ${JSON.stringify((spec as { kind?: unknown }).kind)}`);
  }
}
