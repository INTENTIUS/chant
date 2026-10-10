/**
 * The rebuild migration's pieces that need no server (#3198): the Op's
 * shape and its contracts, the partition arithmetic, the working-object
 * trailer, and the plan's hand-off to the Op. `rebuild.e2e.test.ts` runs it
 * against the pinned server.
 */

import { describe, expect, test } from "vitest";
import {
  collectActivityContracts,
  gatePolicyVersion,
  loadActivityContracts,
  mergeActivityContracts,
  validateActivitySteps,
  validateStepOutputRefs,
  type ActivityContract,
  type OpConfig,
} from "@intentius/chant/op";
import * as contractsModule from "../../op/activity-contracts";
import * as activitiesModule from "../../op/activities";
import { ClickHouseRebuildOp, type ClickHouseRebuildOpConfig } from "./op";
import { copiedColumns } from "./observe";
import { partitionEffect } from "./backfill";
import { insertTarget, waitForCutover, type CutoverProbe } from "./steps";
import { intoShard, onShard, onShardServers, shardTable } from "./shards";
import { renameColumns, sourcePartitionExpression } from "./partitions";
import { canonicalObject } from "../plan/normalize";
import { diffSchemas } from "../plan/diff";
import { renderDiff } from "../plan/report";
import { rebuildOpSuggestions } from "../plan/rebuild-handoff";
import { isChantWorkingObject, isRebuildObject, readMarker, stampedComment, stripMarkerFromStatement } from "../ownership";

const BASE: ClickHouseRebuildOpConfig = {
  name: "rebuild-events",
  env: "prod",
  table: "shop.events",
  dualWrite: { mode: "materialized-view", cutoverColumn: "ts" },
};
const propsOf = (config: ClickHouseRebuildOpConfig) => (ClickHouseRebuildOp(config).op as unknown as { props: OpConfig }).props;

describe("ClickHouseRebuildOp", () => {
  test("its phases, in order, with onFailure dropping the new table", () => {
    const props = propsOf(BASE);
    expect(props.phases.map((p) => p.name)).toEqual([
      "Build",
      "Plan",
      "Create",
      "Dual write",
      "Backfill",
      "Verify",
      "Approve",
      "Swap",
      "Retain",
      "Approve drop",
      "Drop",
    ]);
    expect(props.onFailure?.map((p) => p.steps.map((s) => (s as { fn?: string }).fn))).toEqual([["clickhouseRebuildCompensate"]]);
    expect(props.labels).toEqual({ Rebuild: "true", Env: "prod", Table: "shop.events" });
  });

  test("the swap gate binds the verification's digest and the drop gate the retained table's", () => {
    const props = propsOf(BASE);
    const gates = props.phases.flatMap((p) => p.steps).filter((s) => s.kind === "gate") as Array<{ gate: string; plan: unknown }>;
    expect(gates.map((g) => g.gate)).toEqual(["approve-rebuild-events", "approve-rebuild-events-drop"]);
    expect(JSON.stringify(gates[0]!.plan)).toContain('"verify"');
    expect(JSON.stringify(gates[0]!.plan)).toContain('"planDigest"');
    expect(JSON.stringify(gates[1]!.plan)).toContain('"dropDigest"');
  });

  test("app mode replaces the dual-write view with a gate for the write stop", () => {
    const props = propsOf({ ...BASE, dualWrite: { mode: "app" }, build: false });
    expect(props.phases[0]!.name).toBe("Plan");
    const dual = props.phases.find((p) => p.name === "Dual write")!;
    expect(dual.steps).toEqual([expect.objectContaining({ kind: "gate", gate: "rebuild-events-writes-stopped" })]);
  });

  test("a policy on the swap gate gets the verification's counts as context", () => {
    const text = "permit (principal, action, resource);";
    const policy = { kind: "gate-policy" as const, lexicon: "cedar", name: "ship", version: gatePolicyVersion(text), text };
    const props = propsOf({ ...BASE, gate: { approval: { policy, mode: "log-only" } } });
    const gate = props.phases.find((p) => p.name === "Approve")!.steps[0] as { approval: { context: Record<string, unknown> } };
    expect(Object.keys(gate.approval.context)).toEqual(["verifiedPartitions", "verifiedRows"]);
  });

  test('gates: "outer" leaves out both approval gates and the Drop phase, and keeps the verification (#3658)', () => {
    const props = propsOf({ ...BASE, gates: "outer" });
    expect(props.phases.map((p) => p.name)).toEqual(["Build", "Plan", "Create", "Dual write", "Backfill", "Verify", "Swap", "Retain"]);
    expect(props.phases.flatMap((p) => p.steps).filter((s) => s.kind === "gate")).toEqual([]);
    const fns = props.phases.flatMap((p) => p.steps).map((s) => (s as { fn?: string }).fn);
    expect(fns.indexOf("clickhouseRebuildVerify")).toBeLessThan(fns.indexOf("clickhouseRebuildSwap"));
    expect(fns).not.toContain("clickhouseRebuildDrop");
    // Its own onFailure is unchanged.
    expect(props.onFailure?.map((p) => p.steps.map((s) => (s as { fn?: string }).fn))).toEqual([["clickhouseRebuildCompensate"]]);
    expect(props.overview).toContain("the caller's approval");
  });

  test('gates: "outer" in app mode keeps the writes-stopped gate, which is not an approval (#3658)', () => {
    const props = propsOf({ ...BASE, dualWrite: { mode: "app" }, gates: "outer" });
    const gates = props.phases.flatMap((p) => p.steps).filter((s) => s.kind === "gate") as Array<{ gate: string }>;
    expect(gates.map((g) => g.gate)).toEqual(["rebuild-events-writes-stopped"]);
  });

  test('onFailure: "keep" has no onFailure and tells every step so (#3658)', () => {
    const props = propsOf({ ...BASE, onFailure: "keep" });
    expect(props.onFailure).toBeUndefined();
    const steps = props.phases.flatMap((p) => p.steps).filter((s) => s.kind === "activity" && (s as { fn: string }).fn.startsWith("clickhouseRebuild")) as Array<{ args: Record<string, unknown> }>;
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s.args.keepOnFailure).toBe(true);
    expect(props.phases.map((p) => p.name)).toContain("Approve");
    expect((propsOf(BASE).phases[1]!.steps[0] as { args: Record<string, unknown> }).args).not.toHaveProperty("keepOnFailure");
  });

  test("bad configuration fails when the Op is built", () => {
    expect(() => ClickHouseRebuildOp({ ...BASE, gates: "none" as never })).toThrow(/gates must be/);
    expect(() => ClickHouseRebuildOp({ ...BASE, onFailure: "retry" as never })).toThrow(/onFailure must be/);
    expect(() => ClickHouseRebuildOp({ ...BASE, table: "shop.events; DROP" })).toThrow(/table must be/);
    expect(() => ClickHouseRebuildOp({ ...BASE, dualWrite: { mode: "materialized-view", cutoverColumn: "" } })).toThrow(/cutoverColumn/);
    expect(() => ClickHouseRebuildOp({ ...BASE, dualWrite: { mode: "both" } as never })).toThrow(/dualWrite\.mode/);
  });

  test("every step passes the contracts OPS012 and OPS013 check it against at build", async () => {
    const contracts = new Map<string, ActivityContract>();
    collectActivityContracts(contractsModule as unknown as Record<string, unknown>, contracts);
    const merged = mergeActivityContracts(await loadActivityContracts([]), contracts);
    for (const config of [
      BASE,
      { ...BASE, dualWrite: { mode: "app" as const }, retain: "3d", replicaTimeout: "30s", stack: "shop", ownershipEnv: "prod" },
      { ...BASE, gates: "outer" as const, onFailure: "keep" as const },
    ]) {
      const props = propsOf(config);
      expect(validateActivitySteps(props, merged)).toEqual([]);
      expect(validateStepOutputRefs(props, merged)).toEqual([]);
    }
  });

  test("every rebuild step is an activity the sql lexicon exports, and the receipt activities are only fallbacks", () => {
    const exported = new Set(Object.entries(activitiesModule).filter(([, v]) => typeof v === "function").map(([k]) => k));
    const steps = propsOf(BASE).phases.flatMap((p) => p.steps).filter((s) => s.kind === "activity" && (s as { fn: string }).fn.startsWith("clickhouseRebuild"));
    for (const s of steps) expect(exported.has((s as { fn: string }).fn)).toBe(true);
    // The receipt activities are exported for effect() steps only as fallbacks (#3657), so they never take over another lexicon's receipt row.
    expect((activitiesModule as { ACTIVITY_FALLBACKS?: readonly string[] }).ACTIVITY_FALLBACKS).toEqual(["receiptRead", "receiptWrite", "receiptStaleness"]);
  });
});

describe("partitions", () => {
  const copied = [
    { name: "ts", source: "ts" },
    { name: "account", source: "user_id" },
  ];

  test("an unchanged key is the new table's own partition id", () => {
    expect(sourcePartitionExpression("toYYYYMM(ts)", "toYYYYMM(ts)", copied)).toBe("_partition_id");
  });
  test("a changed key computes the old one over the new table's columns", () => {
    expect(sourcePartitionExpression("toYYYYMM(ts)", "toDate(ts)", copied)).toBe("partitionID(toYYYYMM(ts))");
    expect(sourcePartitionExpression("(user_id, toYYYYMM(ts))", "toYYYYMM(ts)", copied)).toBe("partitionID(`account`, toYYYYMM(ts))");
    expect(sourcePartitionExpression("user_id % 4", "user_id % 4", copied)).toBe("partitionID(`account` % 4)");
  });
  test("no partition key is the one partition `all`", () => {
    expect(sourcePartitionExpression("", "toYYYYMM(ts)", copied)).toBe("'all'");
  });
  test("renaming leaves function names and other columns alone", () => {
    expect(renameColumns("cityHash64(user_id) + user_id_extra", copied)).toBe("cityHash64(`account`) + user_id_extra");
  });

  test("the copied columns follow renames and skip what the new table computes", () => {
    const live = canonicalObject("CREATE TABLE t (ts DateTime, user_id UInt64, kind String) ENGINE = MergeTree ORDER BY ts");
    const declared = canonicalObject(
      "CREATE TABLE t (ts DateTime, account UInt64, -- previously: user_id\n kind String, day Date MATERIALIZED toDate(ts), fresh UInt8 DEFAULT 1) ENGINE = MergeTree ORDER BY (account, ts)",
    );
    expect(copiedColumns(declared, live)).toEqual([
      { name: "ts", source: "ts" },
      { name: "account", source: "user_id" },
      { name: "kind", source: "kind" },
    ]);
  });
});

describe("working objects", () => {
  const marker = { stack: "shop", env: "prod" };

  test("the trailer carries the rebuild's pairs after the marker, and still reads as this project's", () => {
    const c = stampedComment(undefined, marker, { rebuild: "shop.events", role: "dual", cutover: "2026-10-02T12:00:00.000Z" });
    expect(c).toBe("[chant managed-by=chant stack=shop env=prod rebuild=shop.events role=dual cutover=2026-10-02T12%3A00%3A00.000Z]");
    expect(readMarker(c)).toEqual({ managedBy: "chant", ...marker });
    expect(isRebuildObject(c)).toBe(true);
    expect(isChantWorkingObject(c)).toBe(true);
    expect(isRebuildObject("Raw events [chant managed-by=chant stack=shop env=prod]")).toBe(false);
    expect(isChantWorkingObject("chant effect receipts [chant managed-by=chant receipts=effects]")).toBe(true);
    expect(stripMarkerFromStatement(`CREATE TABLE t (x UInt8) ENGINE = Log COMMENT 'Raw ${c}'`)).toBe("CREATE TABLE t (x UInt8) ENGINE = Log COMMENT 'Raw'");
  });

  test("a trailer key outside the pair grammar is refused", () => {
    expect(() => stampedComment(undefined, marker, { "bad key": "x" })).toThrow(/is not/);
  });
});

describe("the plan hands a rebuild to the Op", () => {
  const ddl = (orderBy: string, timeType = "DateTime") => `CREATE TABLE shop.events (ts ${timeType}, user_id UInt64) ENGINE = MergeTree ORDER BY ${orderBy}`;

  test("each refused table gets a ClickHouseRebuildOp declaration, materialized-view mode on its time column", () => {
    const after = [{ key: "events", canonical: canonicalObject(ddl("(user_id, ts)")) }];
    const diff = diffSchemas([{ key: "events", canonical: canonicalObject(ddl("(ts, user_id)")) }], after);
    const ops = rebuildOpSuggestions(diff, new Map(after.map((o) => [o.key, o.canonical])), "prod");
    expect(ops).toEqual([
      {
        table: "shop.events",
        name: "rebuild-shop-events",
        env: "prod",
        dualWrite: { mode: "materialized-view", cutoverColumn: "ts" },
        declaration:
          'export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "prod", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "ts" } });',
      },
    ]);
    const text = renderDiff({ ...diff, rebuildOps: ops });
    expect(text).toMatch(/Refused: 1 change\(s\) need a rebuild/);
    expect(text).toContain("ClickHouseRebuildOp } from \"@intentius/chant-lexicon-sql/clickhouse\"");
    expect(text).toContain(ops[0]!.declaration);
  });

  test("a table with no time column is suggested app mode", () => {
    const noTime = (o: string) => `CREATE TABLE shop.clicks (id UInt64, url String) ENGINE = MergeTree ORDER BY ${o}`;
    const after = [{ key: "clicks", canonical: canonicalObject(noTime("(url, id)")) }];
    const diff = diffSchemas([{ key: "clicks", canonical: canonicalObject(noTime("id")) }], after);
    expect(rebuildOpSuggestions(diff, new Map(after.map((o) => [o.key, o.canonical])), "<env>")[0]!.dualWrite).toEqual({ mode: "app" });
  });
});

describe("a rebuild across the shards of a cluster (#3663)", () => {
  const sharding = { cluster: "main", shards: [{ num: 1, macro: "s1", slot: 0 }, { num: 2, macro: "s2", slot: 1 }] };
  const shard2 = sharding.shards[1]!;

  test("each (shard, partition) is its own receipt; one shard keeps the address it always had", () => {
    expect(partitionEffect("shop.events", "202602")).toBe("rebuild/shop.events/202602");
    expect(partitionEffect("shop.events", "202602", shard2)).toBe("rebuild/shop.events/shard2/202602");
  });

  test("a shard is read through the cluster, written back with its own sharding key, and cleared by its own macro", () => {
    expect(`SELECT * FROM ${shardTable(sharding, "shop", "events")} WHERE ${onShard(shard2)}`).toBe("SELECT * FROM cluster('main', `shop`, `events`) WHERE _shard_num = 2");
    expect(intoShard(sharding, shard2, "shop", "events__chant_new")).toBe("FUNCTION cluster('main', `shop`, `events__chant_new`, 1)");
    expect(onShardServers(shard2)).toBe("getMacro('shard') = 's2'");
  });
});

describe("the wait for the cut-over (#3700)", () => {
  const CUT = Date.parse("2026-10-10T12:00:05Z");
  /** A probe on a fake clock that starts at `start` and moves with real time, and writes that finish after `writesFor` polls. */
  function probe(start: number, writesFor: number): CutoverProbe & { polls: number } {
    const t0 = Date.now();
    const p = {
      polls: 0,
      now: async () => start + (Date.now() - t0),
      pendingWrites: async (cutover: number) => {
        expect(cutover).toBe(CUT);
        p.polls++;
        return p.polls <= writesFor ? ["insert-1"] : [];
      },
    };
    return p;
  }
  const run = (lines: string[] = []) => ({ log: (l: string) => void lines.push(l) });

  test("it ends as soon as the clock has passed the cut-over and no write begun before it is running", async () => {
    const lines: string[] = [];
    const p = probe(CUT - 300, 2);
    const began = Date.now();
    await waitForCutover(run(lines), CUT, p, { pollMs: 10 });
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(p.polls).toBe(3);
    expect(lines[0]).toMatch(/^-- waiting 1s for the cut-over at 2026-10-10T12:00:05.000Z/);
    expect(lines.filter((l) => l.includes("insert-1"))).toHaveLength(1);
  });

  test("a quiet table past its cut-over does not wait at all", async () => {
    const p = probe(CUT + 1, 0);
    const began = Date.now();
    await waitForCutover(run(), CUT, p);
    expect(Date.now() - began).toBeLessThan(100);
    expect(p.polls).toBe(1);
  });

  test("a write still running at the timeout stops the step, naming it", async () => {
    await expect(waitForCutover(run(), CUT, probe(CUT + 1, Infinity), { timeoutMs: 50, pollMs: 10 })).rejects.toThrow(
      /begun before the cut-over at 2026-10-10T12:00:05.000Z are still running after 0s: insert-1\. .*cutoverTimeout/,
    );
  });

  test("the table an INSERT writes to", () => {
    expect(insertTarget("INSERT INTO shop.events VALUES (1)", "default")).toEqual({ database: "shop", name: "events" });
    expect(insertTarget("  /* app */ insert into `shop`.`events` (ts) FORMAT JSONEachRow", "default")).toEqual({ database: "shop", name: "events" });
    expect(insertTarget("INSERT INTO TABLE events SELECT 1", "shop")).toEqual({ database: "shop", name: "events" });
    expect(insertTarget('INSERT INTO "shop" . "events" VALUES', "default")).toEqual({ database: "shop", name: "events" });
    expect(insertTarget("INSERT INTO FUNCTION remote('h', shop.events) VALUES (1)", "shop")).toBeUndefined();
    expect(insertTarget("SELECT * FROM shop.events", "shop")).toBeUndefined();
  });
});
