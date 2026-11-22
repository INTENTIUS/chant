import { afterAll, describe, expect, test, vi } from "vitest";
import { cleanupTestDir, createTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { readDrillLedger } from "../../lifecycle/drill-ledger";
import { restoreDrill, type DrillCheck, type RestoreDrillArgs } from "./restore-drill";
import { drillAdapterFor, isoOf, type DrillAdapter, type DrillExec, type DrillStoreSpec } from "./restore-drill-stores";
import { knownOutputsOf } from "../activity-failure";
import type { DrillRecord } from "../../lifecycle/drill-record";

const M = 60_000;
const H = 3_600_000;
const T0 = Date.parse("2026-11-21T12:00:00.000Z");

/** A clock that moves only when the test says so. */
function clock() {
  let t = T0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** An adapter whose stages take the time the test gives them. */
function adapter(c: ReturnType<typeof clock>, o: { backupAgeMs?: number; restoreMs?: number; fail?: "backup" | "restore" | "teardown" } = {}) {
  const calls: string[] = [];
  const a: DrillAdapter = {
    async newestBackup() {
      calls.push("newestBackup");
      if (o.fail === "backup") throw new Error("no available snapshot");
      return { id: "snap-1", at: new Date(c.now() - (o.backupAgeMs ?? 10 * M)).toISOString() };
    },
    async restore(_b, scratch) {
      calls.push(`restore ${scratch}`);
      c.advance(o.restoreMs ?? 30 * M);
      if (o.fail === "restore") throw new Error("restore refused");
      return { endpoint: "db.scratch:5432" };
    },
    async teardown(scratch) {
      calls.push(`teardown ${scratch}`);
      if (o.fail === "teardown") throw new Error("delete refused");
    },
  };
  return { a, calls };
}

const store: DrillStoreSpec = { kind: "rds", name: "orders", instance: "orders-prod" };

function run(c: ReturnType<typeof clock>, a: DrillAdapter, extra: Partial<RestoreDrillArgs> = {}) {
  const recorded: DrillRecord[] = [];
  const args: RestoreDrillArgs = {
    store,
    env: "prod",
    op: "orders-restore-drill",
    targets: { rto: "4h", rpo: "15m" },
    _adapter: a,
    _now: c.now,
    _id: () => "drill-id-1",
    _record: async (r) => void recorded.push(r),
    ...extra,
  };
  return { recorded, result: restoreDrill(args) };
}

describe("restoreDrill: a drill that meets its targets", () => {
  test("measures RPO as the backup's age and RTO as restore plus checks, tears down, and records", async () => {
    const c = clock();
    const { a, calls } = adapter(c, { backupAgeMs: 10 * M, restoreMs: 2 * H });
    const checks: DrillCheck[] = [{ name: "rows", kind: "command", cmd: "count", expect: { atLeast: 100 } }];
    const exec: DrillExec = async (argv, o) => {
      expect(argv).toEqual(["sh", "-c", "count"]);
      expect(o?.env).toMatchObject({ DRILL_STORE: "orders", DRILL_ENDPOINT: "db.scratch:5432" });
      c.advance(5 * M);
      return { stdout: "4200\n" };
    };
    const { recorded, result } = run(c, a, { checks, _exec: exec });
    const r = await result;

    expect(r).toMatchObject({ outcome: "passed", rpoMs: 10 * M, restoreMs: 2 * H, rtoMs: 2 * H + 5 * M, met: true, checksPassed: 1, checksTotal: 1, tornDown: true, backupId: "snap-1" });
    expect(calls).toEqual(["newestBackup", expect.stringMatching(/^restore drill-orders-/), expect.stringMatching(/^teardown drill-orders-/)]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      version: 1,
      id: "drill-id-1",
      store: "orders",
      kind: "rds",
      env: "prod",
      op: "orders-restore-drill",
      outcome: "passed",
      targets: { rtoMs: 4 * H, rpoMs: 15 * M },
      shortfall: {},
      checks: [{ name: "rows", kind: "command", ok: true, durationMs: 5 * M }],
      started: "2026-11-21T12:00:00.000Z",
      ended: "2026-11-21T14:05:00.000Z",
    });
  });

  test("a drill with no targets passes and leaves met null", async () => {
    const c = clock();
    const { a } = adapter(c);
    const { result } = run(c, a, { targets: undefined });
    expect(await result).toMatchObject({ outcome: "passed", met: null });
  });
});

describe("restoreDrill: a drill that misses a target", () => {
  test("fails, says by how much, and has recorded the measurements first", async () => {
    const c = clock();
    const { a, calls } = adapter(c, { backupAgeMs: 25 * M, restoreMs: 5 * H });
    const { recorded, result } = run(c, a);
    const err = await result.then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe("restore drill orders missed: RTO 5h against 4h, over by 1h; RPO 25m against 15m, over by 10m");
    expect(recorded[0]).toMatchObject({ outcome: "missed", met: false, rtoMs: 5 * H, rpoMs: 25 * M, shortfall: { rtoMs: H, rpoMs: 10 * M } });
    expect(calls.at(-1)).toMatch(/^teardown /);
    expect(knownOutputsOf(err)).toMatchObject({ outcome: "missed", rtoMs: 5 * H, rpoMs: 25 * M, met: false });
  });
});

describe("restoreDrill: a drill that fails", () => {
  test("a check that fails fails the drill, records every check and no RTO", async () => {
    const c = clock();
    const { a } = adapter(c);
    const checks: DrillCheck[] = [
      { name: "rows", kind: "command", cmd: "count", expect: { atLeast: 100 } },
      { name: "health", kind: "http", url: "http://${DRILL_ENDPOINT}/health", status: 200 },
    ];
    const seen: string[] = [];
    const { recorded, result } = run(c, a, {
      checks,
      _exec: async () => ({ stdout: "7\n" }),
      _fetch: async (url) => {
        seen.push(url);
        return { status: 200, text: async () => "" };
      },
    });
    const err = await result.then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/^restore drill orders failed: check rows failed: printed 7, wanted at least 100$/);
    expect(seen).toEqual(["http://db.scratch:5432/health"]);
    expect(recorded[0]).toMatchObject({ outcome: "failed", rtoMs: null, met: null });
    expect(recorded[0].checks.map((x) => [x.name, x.ok])).toEqual([["rows", false], ["health", true]]);
    expect(recorded[0].rpoMs).toBe(10 * M);
  });

  test("a restore that errors is torn down, recorded with no RTO, and fails", async () => {
    const c = clock();
    const { a, calls } = adapter(c, { fail: "restore" });
    const { recorded, result } = run(c, a);
    await expect(result).rejects.toThrow(/restore drill orders failed: failed: restore refused/);
    expect(calls.at(-1)).toMatch(/^teardown /);
    expect(recorded[0]).toMatchObject({ outcome: "failed", rtoMs: null, restoreMs: null, error: "restore refused", tornDown: true });
  });

  test("no backup fails before anything is restored or torn down", async () => {
    const c = clock();
    const { a, calls } = adapter(c, { fail: "backup" });
    const { recorded, result } = run(c, a);
    await expect(result).rejects.toThrow(/no available snapshot/);
    expect(calls).toEqual(["newestBackup"]);
    expect(recorded[0]).toMatchObject({ outcome: "failed", backup: null, rpoMs: null, rtoMs: null });
  });

  test("a scratch environment that cannot be torn down fails a passing drill and is recorded", async () => {
    const c = clock();
    const { a } = adapter(c, { fail: "teardown" });
    const { recorded, result } = run(c, a);
    await expect(result).rejects.toThrow(/left scratch behind: scratch drill-orders-\S+ was not torn down: delete refused/);
    expect(recorded[0]).toMatchObject({ outcome: "passed", tornDown: false, tearDownError: "delete refused" });
  });

  test("a drill that cannot be recorded fails and carries the measurements", async () => {
    const c = clock();
    const { a } = adapter(c);
    const res = restoreDrill({ store, _adapter: a, _now: c.now, _record: async () => Promise.reject(new Error("ledger locked")) });
    const err = await res.then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/could not record them: ledger locked/);
    expect(knownOutputsOf(err)).toMatchObject({ outcome: "passed", rpoMs: 10 * M });
  });
});

describe("restoreDrill: checks", () => {
  test("a command check retries until it passes", async () => {
    const c = clock();
    const { a } = adapter(c);
    let n = 0;
    const { result } = run(c, a, {
      checks: [{ name: "ready", kind: "command", cmd: "x", expect: { equals: "ok" }, retries: 2, intervalMs: 1 }],
      _exec: async () => ({ stdout: ++n < 3 ? "warming" : "ok" }),
    });
    expect(await result).toMatchObject({ outcome: "passed", checksPassed: 1 });
    expect(n).toBe(3);
  });

  test("a command that exits non-zero fails its check with the command's message", async () => {
    const c = clock();
    const { a } = adapter(c);
    const { recorded, result } = run(c, a, { checks: [{ name: "q", kind: "command", cmd: "x" }], _exec: async () => Promise.reject(new Error("sh -c x: connection refused")) });
    await expect(result).rejects.toThrow(/check q failed: sh -c x: connection refused/);
    expect(recorded[0].checks[0]).toMatchObject({ ok: false, detail: "sh -c x: connection refused" });
  });
});

describe("restoreDrill: refusals before anything is created", () => {
  const never = async () => {
    throw new Error("must not run");
  };
  const refuses = (args: Partial<RestoreDrillArgs>, message: RegExp) =>
    expect(restoreDrill({ store, _exec: never, _adapter: { newestBackup: never, restore: never, teardown: never }, ...args })).rejects.toThrow(message);

  test("a scratch name that does not start with drill- is refused", () => refuses({ scratch: "orders-prod" }, /must start with "drill-"/));
  test("a scratch name equal to the store is refused", () =>
    refuses({ store: { kind: "dynamodb", name: "t", table: "drill-t" }, scratch: "drill-t" }, /is the store itself/));
  test("two checks with one name are refused", () =>
    refuses({ checks: [{ name: "a", kind: "command", cmd: "x" }, { name: "a", kind: "command", cmd: "y" }] }, /two checks are named "a"/));
  test("a target that is not a duration is refused", () => refuses({ targets: { rto: "soon" } }, /rto: "soon" is not a duration/));
  test("an unknown store kind is refused", () => refuses({ store: { kind: "oracle", name: "x" } as never }, /store.kind/));
});

/** A fake that answers each command by its leading words and keeps the order. */
function fakeExec(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  const exec: DrillExec = async (argv) => {
    const line = argv.join(" ");
    calls.push(line);
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    if (key === undefined) throw new Error(`unexpected command: ${line}`);
    const a = answers[key];
    if (a instanceof Error) throw a;
    return { stdout: a };
  };
  return { exec, calls };
}

describe("store adapters over a fake CLI", () => {
  test("rds: picks the newest available snapshot, restores, waits, and reads the endpoint", async () => {
    const { exec, calls } = fakeExec({
      "aws rds describe-db-snapshots": JSON.stringify({
        DBSnapshots: [
          { DBSnapshotIdentifier: "old", Status: "available", SnapshotCreateTime: "2026-11-20T00:00:00Z" },
          { DBSnapshotIdentifier: "new", Status: "available", SnapshotCreateTime: "2026-11-21T06:00:00Z" },
          { DBSnapshotIdentifier: "creating", Status: "creating", SnapshotCreateTime: "2026-11-21T11:00:00Z" },
        ],
      }),
      "aws rds restore-db-instance-from-db-snapshot": "{}",
      "aws rds wait db-instance-available": "",
      "aws rds describe-db-instances": JSON.stringify({ DBInstances: [{ Endpoint: { Address: "h.example", Port: 5432 } }] }),
      "aws rds delete-db-instance": "{}",
    });
    const ad = drillAdapterFor({ kind: "rds", name: "orders", instance: "orders-prod" }, exec);
    const b = await ad.newestBackup();
    expect(b).toEqual({ id: "new", at: "2026-11-21T06:00:00.000Z" });
    expect(await ad.restore(b, "drill-orders-1")).toEqual({ endpoint: "h.example:5432" });
    await ad.teardown("drill-orders-1");
    expect(calls).toContain("aws rds restore-db-instance-from-db-snapshot --db-instance-identifier drill-orders-1 --db-snapshot-identifier new --no-publicly-accessible");
    expect(calls.at(-1)).toBe("aws rds delete-db-instance --db-instance-identifier drill-orders-1 --skip-final-snapshot --delete-automated-backups");
  });

  test("rds: an instance with no available snapshot says so", async () => {
    const { exec } = fakeExec({ "aws rds describe-db-snapshots": JSON.stringify({ DBSnapshots: [] }) });
    await expect(drillAdapterFor({ kind: "rds", name: "o", instance: "orders-prod" }, exec).newestBackup()).rejects.toThrow("no available snapshot of RDS instance orders-prod");
  });

  test("teardown accepts a scratch environment that is already gone, and nothing else", async () => {
    const gone = fakeExec({ "aws rds delete-db-instance": new Error("DBInstanceNotFound: no such instance") });
    await expect(drillAdapterFor({ kind: "rds", name: "o", instance: "i" }, gone.exec).teardown("drill-o-1")).resolves.toBeUndefined();
    const denied = fakeExec({ "aws rds delete-db-instance": new Error("AccessDenied") });
    await expect(drillAdapterFor({ kind: "rds", name: "o", instance: "i" }, denied.exec).teardown("drill-o-1")).rejects.toThrow("AccessDenied");
  });

  test("aurora: restores the cluster, adds a member, and tears the member down before the cluster", async () => {
    const { exec, calls } = fakeExec({
      "aws rds describe-db-cluster-snapshots": JSON.stringify({ DBClusterSnapshots: [{ DBClusterSnapshotIdentifier: "c1", Status: "available", SnapshotCreateTime: "2026-11-21T01:00:00Z" }] }),
      "aws rds restore-db-cluster-from-snapshot": "{}",
      "aws rds create-db-instance": "{}",
      "aws rds wait": "",
      "aws rds describe-db-clusters": JSON.stringify({ DBClusters: [{ Endpoint: "c.example", Port: 5432 }] }),
      "aws rds delete-db-instance": "{}",
      "aws rds delete-db-cluster": "{}",
    });
    const ad = drillAdapterFor({ kind: "aurora", name: "ledger", cluster: "ledger-prod", engine: "aurora-postgresql", instanceClass: "db.r6g.large" }, exec);
    const b = await ad.newestBackup();
    expect(await ad.restore(b, "drill-ledger-1")).toEqual({ endpoint: "c.example:5432" });
    await ad.teardown("drill-ledger-1");
    expect(calls.filter((c) => /delete-db/.test(c))).toEqual([
      "aws rds delete-db-instance --db-instance-identifier drill-ledger-1-1 --skip-final-snapshot",
      "aws rds delete-db-cluster --db-cluster-identifier drill-ledger-1 --skip-final-snapshot",
    ]);
  });

  test("dynamodb: the backup is the latest restorable time, and the restore asks for exactly that time", async () => {
    const { exec, calls } = fakeExec({
      "aws dynamodb describe-continuous-backups": JSON.stringify({ ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "ENABLED", LatestRestorableDateTime: 1795262400 } } }),
      "aws dynamodb restore-table-to-point-in-time": "{}",
      "aws dynamodb wait": "",
      "aws dynamodb delete-table": "{}",
    });
    const ad = drillAdapterFor({ kind: "dynamodb", name: "sessions", table: "sessions" }, exec);
    const b = await ad.newestBackup();
    expect(b).toEqual({ id: "point-in-time", at: new Date(1795262400 * 1000).toISOString() });
    await ad.restore(b, "drill-sessions-1");
    expect(calls).toContain(`aws dynamodb restore-table-to-point-in-time --source-table-name sessions --target-table-name drill-sessions-1 --restore-date-time ${b.at}`);
  });

  test("dynamodb: a table without point-in-time recovery has nothing to restore", async () => {
    const { exec } = fakeExec({ "aws dynamodb describe-continuous-backups": JSON.stringify({ ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "DISABLED" } } }) });
    await expect(drillAdapterFor({ kind: "dynamodb", name: "s", table: "sessions" }, exec).newestBackup()).rejects.toThrow("has no point-in-time recovery");
  });

  test("s3: the backup is the newest current version under the prefix, restored by sync into a new bucket", async () => {
    const { exec, calls } = fakeExec({
      "aws s3api list-object-versions": JSON.stringify({
        Versions: [
          { Key: "a", VersionId: "v1", IsLatest: true, LastModified: "2026-11-21T09:00:00Z" },
          { Key: "b", VersionId: "v2", IsLatest: true, LastModified: "2026-11-21T11:30:00Z" },
          { Key: "b", VersionId: "v0", IsLatest: false, LastModified: "2026-11-21T11:59:00Z" },
        ],
      }),
      "aws s3 mb": "",
      "aws s3 sync": "",
      "aws s3 rb": "",
    });
    const ad = drillAdapterFor({ kind: "s3", name: "uploads", bucket: "uploads-prod", prefix: "img/" }, exec);
    const b = await ad.newestBackup();
    expect(b.at).toBe("2026-11-21T11:30:00.000Z");
    expect(await ad.restore(b, "drill-uploads-1")).toEqual({ endpoint: "s3://drill-uploads-1" });
    expect(calls).toContain("aws s3 sync s3://uploads-prod/img/ s3://drill-uploads-1/ --only-show-errors");
  });

  test("velero: the newest completed backup that covers the namespace, restored into a mapped namespace", async () => {
    const backup = (name: string, phase: string, start: string, namespaces: string[], schedule?: string) => ({
      metadata: { name, ...(schedule ? { labels: { "velero.io/schedule-name": schedule } } : {}) },
      spec: { includedNamespaces: namespaces },
      status: { phase, startTimestamp: start },
    });
    const { exec, calls } = fakeExec({
      "velero backup get": JSON.stringify({
        items: [
          backup("a", "Completed", "2026-11-21T02:00:00Z", ["shop"], "nightly"),
          backup("b", "Completed", "2026-11-21T03:00:00Z", ["shop"], "nightly"),
          backup("c", "PartiallyFailed", "2026-11-21T04:00:00Z", ["shop"], "nightly"),
          backup("d", "Completed", "2026-11-21T05:00:00Z", ["other"], "nightly"),
          backup("e", "Completed", "2026-11-21T06:00:00Z", ["shop"], "adhoc"),
        ],
      }),
      "velero restore create": "",
      "velero restore get": JSON.stringify({ status: { phase: "Completed" } }),
      "kubectl delete namespace": "",
      "velero restore delete": "",
    });
    const ad = drillAdapterFor({ kind: "velero", name: "shop", namespace: "shop", schedule: "nightly" }, exec);
    const b = await ad.newestBackup();
    expect(b).toEqual({ id: "b", at: "2026-11-21T03:00:00.000Z" });
    await ad.restore(b, "drill-shop-1");
    await ad.teardown("drill-shop-1");
    expect(calls).toContain("velero restore create drill-shop-1 --from-backup b --namespace-mappings shop:drill-shop-1 --wait");
    expect(calls).toContain("kubectl delete namespace drill-shop-1 --ignore-not-found --wait=true");
  });

  test("velero: a restore that ends in another phase than Completed fails", async () => {
    const { exec } = fakeExec({ "velero restore create": "", "velero restore get": JSON.stringify({ status: { phase: "PartiallyFailed" } }) });
    await expect(drillAdapterFor({ kind: "velero", name: "s", namespace: "shop" }, exec).restore({ id: "b", at: "x" }, "drill-s-1")).rejects.toThrow("ended PartiallyFailed, not Completed");
  });

  test("times from the aws CLI are read as an ISO string or as epoch seconds, and nothing else", () => {
    expect(isoOf("2026-11-21T06:00:00Z", "t")).toBe("2026-11-21T06:00:00.000Z");
    expect(isoOf(1795262400, "t")).toBe(new Date(1795262400000).toISOString());
    expect(() => isoOf("yesterday", "t")).toThrow(/not a time/);
  });
});

describe("restoreDrill: the default recorder", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await cleanupTestDir(d);
  });

  test("writes the drill to the chant/lifecycle branch of the checkout and says when there is no remote to push to", async () => {
    const dir = await createTestDir("chant-restore-drill");
    dirs.push(dir);
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@chant.dev"], ["config", "user.name", "T"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
      expect(spawnSync("git", args, { cwd: dir }).status).toBe(0);
    }
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const c = clock();
      const { a } = adapter(c);
      await restoreDrill({ store, env: "prod", targets: { rto: "4h" }, cwd: dir, _adapter: a, _now: c.now });
      const { records, malformed } = await readDrillLedger("prod", { cwd: dir });
      expect(malformed).toBe(0);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ store: "orders", env: "prod", outcome: "passed", rpoMs: 10 * M, rtoMs: 30 * M });
      expect(warn.mock.calls.flat().join("\n")).toMatch(/restore drill orders: recorded locally/);
    } finally {
      warn.mockRestore();
    }
  });
});
