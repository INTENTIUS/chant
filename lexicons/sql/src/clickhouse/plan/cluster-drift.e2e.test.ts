/**
 * Drift on a multi-shard cluster (#3664), against a scratch cluster of the
 * pinned image: two shards (two replicas and one server) with Keeper and a
 * cluster `chant` over all three, the profile naming the first server with
 * topology `cluster:chant`.
 *
 * - The schema applied `ON CLUSTER`, with a `Distributed` table declared with
 *   unquoted identifiers, reads as no drift: the server's quoted arguments
 *   are the same arguments.
 * - A TTL changed on shard 2's server alone, without `ON CLUSTER`, is drift,
 *   seen on that server, though the profile's server still holds the
 *   declaration.
 *
 * Runs the sql lexicon's deep reader and core's deep diff, as
 * `chant lifecycle diff --live` does. Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { diffDeepObservation } from "@intentius/chant/lifecycle/deep-observe";
import { normalizeDeepObservation } from "@intentius/chant/deep-observation";
import { dockerAvailable, startScratchCluster, type ScratchCluster } from "../container";
import { clickhouseQuery } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { clickhouseApply, toApplyResult } from "../../op/activities/clickhouse-apply";
import { normalizeApply } from "@intentius/chant/apply";
import { database, table } from "../entities";
import { observeResourcesDeep, sqlDeepNormalizationHooks } from "./deep";

const enabled = await dockerAvailable();
const DB = "chant_e2e_3664";
let cluster: ScratchCluster | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-cluster-drift-"));

const DB_DDL = `CREATE DATABASE ${DB}`;
const EVENTS_DDL = `CREATE TABLE ${DB}.events
(
  id UInt64,
  ts DateTime
)
ENGINE = MergeTree
ORDER BY id
TTL ts + INTERVAL 30 DAY`;
const EVENTS_ALL_DDL = `CREATE TABLE ${DB}.events_all
(
  id UInt64,
  ts DateTime
)
ENGINE = Distributed(chant, ${DB}, events, id)`;

const config = () => ({ ownership: { stack: "e2e", env: "test" }, sql: { profiles: { e2e: { url: cluster!.replicas[0]!.url, topology: "cluster:chant" } } } });
const tag = (fn: (strings: TemplateStringsArray) => unknown, ddl: string) => fn(Object.assign([ddl], { raw: [ddl] }) as unknown as TemplateStringsArray) as unknown as { entityType: string; props: Record<string, unknown> };

const ENTITIES = new Map([
  ["db", tag(database, DB_DDL)],
  ["events", tag(table, EVENTS_DDL)],
  ["eventsAll", tag(table, EVENTS_ALL_DDL)],
]);

async function drift() {
  const entities = new Map([...ENTITIES].map(([k, v]) => [k, { entityType: v.entityType, props: v.props }]));
  const live = await observeResourcesDeep({ environment: "e2e", entityNames: [...entities.keys()], entities, config: config(), env: {} });
  return diffDeepObservation(entities, normalizeDeepObservation(live), sqlDeepNormalizationHooks).drifted;
}

beforeAll(async () => {
  if (!enabled) return;
  cluster = await startScratchCluster(clickhouseImage(), { shards: [2, 1], cluster: "chant", namePrefix: "chant-sql-cluster-drift" });
}, 600_000);

afterAll(async () => {
  await cluster?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("drift on a two-shard cluster (#3664)", () => {
  test("applied ON CLUSTER, with unquoted Distributed arguments, it reads as no drift", async () => {
    const build = join(dir, "schema.json");
    writeFileSync(
      build,
      JSON.stringify({
        dialect: "clickhouse",
        applyOrder: ["db", "events", "eventsAll"],
        objects: [
          { export: "db", type: "ClickHouse::Database", ddl: DB_DDL, dependsOn: [] },
          { export: "events", type: "ClickHouse::Table", ddl: EVENTS_DDL, dependsOn: ["db"] },
          { export: "eventsAll", type: "ClickHouse::Table", ddl: EVENTS_ALL_DDL, dependsOn: ["events"] },
        ],
      }),
    );
    const applied = normalizeApply(toApplyResult(await clickhouseApply({ buildPath: build, environment: "e2e" }, undefined, { config: config(), env: {}, log: () => undefined })));
    expect(applied.notAttempted).toEqual([]);
    // Every server has both tables.
    for (const endpoint of cluster!.replicas) {
      const rows = await clickhouseQuery<{ name: string }>(endpoint, `SELECT name FROM system.tables WHERE database = '${DB}' ORDER BY name`);
      expect(rows.map((r) => r.name)).toEqual(["events", "events_all"]);
    }
    expect(await drift()).toEqual([]);
  }, 300_000);

  test("a TTL changed on shard 2 alone is drift, seen on that server", async () => {
    const shard2 = cluster!.layout.findIndex((l) => l.shard === "s2");
    await clickhouseQuery(cluster!.replicas[shard2]!, `ALTER TABLE ${DB}.events MODIFY TTL ts + INTERVAL 7 DAY`);
    // The profile's server still holds the declaration.
    const [mine] = await clickhouseQuery<{ q: string }>(cluster!.replicas[0]!, `SELECT create_table_query AS q FROM system.tables WHERE database = '${DB}' AND name = 'events'`);
    expect(mine!.q).toContain("toIntervalDay(30)");

    const drifted = await drift();
    expect(drifted.map((d) => d.name)).toEqual(["events"]);
    const ttl = drifted[0]!.changes.find((c) => c.path.startsWith("ttl"));
    expect(ttl, JSON.stringify(drifted[0]!.changes)).toBeDefined();
    expect(String(ttl!.live)).toMatch(/7/);
    expect(ttl!.seenOn).toBe(cluster!.layout[shard2]!.host);
  }, 300_000);
});
