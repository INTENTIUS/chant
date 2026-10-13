/**
 * Dictionaries against a server (#3653, #3682).
 *
 * On a single node: a declared dictionary is created with chant's marker,
 * plans with no changes and reads back with no drift; a layout and a
 * lifetime changed in the declaration are SQLCH245 and the apply replaces
 * the dictionary; a dictionary made by hand in a declared database is
 * listed, as a drop, never left out; a prune drops the declared one once
 * the build no longer holds it, and leaves the foreign one. A table with
 * the `Dictionary` engine is read as a table.
 *
 * On a Replicated database (two replicas of the pinned server in Docker):
 * the dictionary is created once, through the database, with no
 * `ON CLUSTER`, and both replicas hold it and answer `dictGet`.
 *
 * The single node: `CLICKHOUSE_URL` (with `CLICKHOUSE_USER` and
 * `CLICKHOUSE_PASSWORD`) names a running one, such as the one
 * `chant emulator up --lexicon sql` starts. Without it, a throwaway server at
 * the pin, skipped cleanly when Docker is not available. The test writes
 * only to the database `chant_e2e_3682`, dropped afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchCluster, startScratchServer, type ScratchCluster, type ScratchServer } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { database, dictionary, table } from "../entities";
import { planAgainstServer } from "../plan/commands";
import { observeResourcesDeep, sqlDeepNormalizationHooks } from "../plan/deep";
import { clickhouseApply } from "../../op/activities/clickhouse-apply";

const DB = "chant_e2e_3682";
const fromEnv = process.env.CLICKHOUSE_URL;
const docker = await dockerAvailable();
const enabled = fromEnv !== undefined || docker;
let server: ScratchServer | undefined;
let endpoint: ClickHouseEndpoint;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-dictionaries-"));
const q = <T = Record<string, unknown>>(sql: string, at: ClickHouseEndpoint = endpoint) => clickhouseQuery<T>(at, sql);

beforeAll(async () => {
  if (!enabled) return;
  if (fromEnv !== undefined) {
    endpoint = {
      url: fromEnv,
      ...(process.env.CLICKHOUSE_USER ? { user: process.env.CLICKHOUSE_USER } : {}),
      ...(process.env.CLICKHOUSE_PASSWORD ? { password: process.env.CLICKHOUSE_PASSWORD } : {}),
    };
  } else {
    server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-dictionaries" });
    endpoint = server.endpoint;
  }
  await q(`DROP DATABASE IF EXISTS ${DB} SYNC`);
}, 600_000);

afterAll(async () => {
  if (enabled) await q(`DROP DATABASE IF EXISTS ${DB} SYNC`).catch(() => undefined);
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const envOf = (at: ClickHouseEndpoint, topology?: string) => ({
  CLICKHOUSE_URL: at.url,
  ...(at.user ? { CLICKHOUSE_USER: at.user } : {}),
  ...(at.password ? { CLICKHOUSE_PASSWORD: at.password } : {}),
  ...(topology ? { CLICKHOUSE_TOPOLOGY: topology } : {}),
});
const OWNERSHIP = { stack: "e2e3682", env: "test" };

type Entity = { entityType: string; props: { ddl: string } };
function writeBuild(file: string, declared: Record<string, Entity>): string {
  const path = join(dir, file);
  const objects = Object.entries(declared).map(([k, e]) => ({ export: k, type: e.entityType, ddl: e.props.ddl, dependsOn: [] }));
  writeFileSync(path, JSON.stringify({ dialect: "clickhouse", applyOrder: objects.map((o) => o.export), objects }));
  return path;
}

async function apply(at: ClickHouseEndpoint, buildPath: string, opts: { prune?: boolean; topology?: string } = {}) {
  const sent: string[] = [];
  const outcome = await clickhouseApply({ buildPath, environment: "test", ...(opts.prune ? { prune: true } : {}) }, undefined, {
    config: { ownership: OWNERSHIP },
    env: envOf(at, opts.topology),
    log: (l) => void (/^[A-Z]+ /.test(l) && sent.push(l)),
  });
  return { outcome, sent };
}

const ratesDict = (layout: string, lifetime: string) =>
  dictionary([
    `CREATE DICTIONARY ${DB}.rates_dict (code String, rate Float64 DEFAULT 1) PRIMARY KEY code SOURCE(clickhouse(table 'rates' db '${DB}')) LAYOUT(${layout}) LIFETIME(${lifetime}) COMMENT 'exchange rates'`,
  ] as unknown as TemplateStringsArray);

/** The props a deep diff compares: the declaration's, less what the hooks prune. */
const compared = (props: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(props)) as Record<string, unknown>).filter(([k]) => !sqlDeepNormalizationHooks.prune!({ pattern: k } as never)));

describe.skipIf(!enabled)("a dictionary on a single node (#3682)", () => {
  const shop = database([`CREATE DATABASE ${DB}`] as unknown as TemplateStringsArray);
  const rates = table([`CREATE TABLE ${DB}.rates (code String, rate Float64) ENGINE = MergeTree ORDER BY code`] as unknown as TemplateStringsArray);

  test("created, planned, read back, changed, listed beside a foreign one, and pruned", async () => {
    const v1 = { shop, rates, ratesDict: ratesDict("complex_key_hashed()", "300") };
    const first = await apply(endpoint, writeBuild("v1.json", v1));
    expect(first.outcome.failed).toEqual([]);
    expect(first.outcome.applied.map((a) => [a.name, a.action])).toEqual([
      [DB, "created"],
      [`${DB}.rates`, "created"],
      [`${DB}.rates_dict`, "created"],
    ]);
    await q(`INSERT INTO ${DB}.rates VALUES ('EUR', 1.1), ('GBP', 1.3)`);
    expect((await q<{ r: number }>(`SELECT dictGet('${DB}.rates_dict', 'rate', 'GBP') AS r`))[0]!.r).toBe(1.3);
    // The server prints the layout upper case, the lifetime as MIN and MAX: still the declaration.
    expect((await q<{ s: string }>(`SELECT create_table_query AS s FROM system.tables WHERE database = '${DB}' AND name = 'rates_dict'`))[0]!.s).toMatch(/LIFETIME\(MIN 0 MAX 300\) LAYOUT\(COMPLEX_KEY_HASHED\(\)\)/);

    const diff = await planAgainstServer("test", writeBuild("v1.json", v1), { config: {}, env: envOf(endpoint) });
    expect(diff.changes).toEqual([]);
    expect(diff.unreadable).toBeUndefined();
    const entities = new Map(Object.entries(v1).map(([k, e]) => [k, { entityType: e.entityType, props: e.props as unknown as Record<string, unknown> }]));
    const deep = await observeResourcesDeep({ environment: "test", entityNames: [...entities.keys()], entities, config: {}, env: envOf(endpoint) });
    expect(deep.unobserved ?? {}).toEqual({});
    expect(compared(deep.resources.ratesDict!.properties)).toEqual(compared(v1.ratesDict.props));
    expect(deep.resources.ratesDict!.type).toBe("ClickHouse::Dictionary");

    // A foreign dictionary and a Dictionary-engine table, made by hand: listed, not left out.
    await q(`CREATE DICTIONARY ${DB}.foreign_dict (code String, rate Float64) PRIMARY KEY code SOURCE(CLICKHOUSE(TABLE 'rates' DB '${DB}')) LAYOUT(COMPLEX_KEY_HASHED()) LIFETIME(0)`);
    await q(`CREATE TABLE ${DB}.rates_view (code String, rate Float64) ENGINE = Dictionary(${DB}.rates_dict)`);

    const v2 = { ...v1, ratesDict: ratesDict("complex_key_sparse_hashed()", "MIN 10 MAX 600") };
    const planned = await planAgainstServer("test", writeBuild("v2.json", v2), { config: {}, env: envOf(endpoint) });
    expect(planned.changes.map((c) => [c.object, c.field, c.rule])).toEqual([
      [`ratesDict (${DB}.rates_dict)`, "layout", "SQLCH245"],
      [`ratesDict (${DB}.rates_dict)`, "lifetime", "SQLCH245"],
      [`${DB}.foreign_dict`, "object", "SQLCH250"],
      [`${DB}.rates_view`, "object", "SQLCH250"],
    ]);

    const changed = await apply(endpoint, writeBuild("v2.json", v2));
    expect(changed.sent).toEqual([expect.stringMatching(new RegExp(`^CREATE OR REPLACE DICTIONARY ${DB}\\.rates_dict .*LAYOUT\\(complex_key_sparse_hashed\\(\\)\\) LIFETIME\\(MIN 10 MAX 600\\) COMMENT 'exchange rates \\[chant`))]);
    expect((await q<{ r: number }>(`SELECT dictGet('${DB}.rates_dict', 'rate', 'EUR') AS r`))[0]!.r).toBe(1.1);
    expect((await planAgainstServer("test", writeBuild("v2.json", v2), { config: {}, env: envOf(endpoint) })).changes.map((c) => c.object)).toEqual([
      `${DB}.foreign_dict`,
      `${DB}.rates_view`,
    ]);

    // Pruned once the build no longer declares it; the foreign dictionary carries no marker and stays.
    await q(`DROP TABLE ${DB}.rates_view SYNC`);
    const pruned = await apply(endpoint, writeBuild("v3.json", { shop, rates }), { prune: true });
    expect(pruned.outcome.pruned.map((p) => p.name)).toEqual([`${DB}.rates_dict`]);
    expect(pruned.sent).toEqual([`DROP DICTIONARY \`${DB}\`.\`rates_dict\` SYNC`]);
    const left = await q<{ name: string }>(`SELECT name FROM system.tables WHERE database = '${DB}' ORDER BY name`);
    expect(left.map((t) => t.name)).toEqual(["foreign_dict", "rates"]);
  }, 300_000);
});

describe.skipIf(!docker)("a dictionary in a Replicated database (#3682)", () => {
  let cluster: ScratchCluster | undefined;
  beforeAll(async () => {
    cluster = await startScratchCluster(clickhouseImage(), { replicas: 2, namePrefix: "chant-sql-dictionaries-repl" });
  }, 600_000);
  afterAll(async () => {
    await cluster?.stop();
  });

  test("created once through the database, held by both replicas, with no ON CLUSTER", async () => {
    const [r1, r2] = cluster!.replicas as [ClickHouseEndpoint, ClickHouseEndpoint];
    const shop = database([`CREATE DATABASE ${DB}`] as unknown as TemplateStringsArray);
    const rates = table([`CREATE TABLE ${DB}.rates (code String, rate Float64) ENGINE = MergeTree ORDER BY code`] as unknown as TemplateStringsArray);
    const build = writeBuild("repl.json", { shop, rates, ratesDict: ratesDict("complex_key_hashed()", "300") });
    const first = await apply(r1, build, { topology: "replicated" });
    expect(first.outcome.failed).toEqual([]);
    expect(first.sent.join("\n")).not.toMatch(/ON CLUSTER/);
    // The second replica joins the database with the statement the first was sent, and replays the rest from its log.
    await q(first.sent[0]!, r2);
    await q(`SYSTEM SYNC DATABASE REPLICA ${DB}`, r2);
    await q(`INSERT INTO ${DB}.rates VALUES ('EUR', 1.1)`, r1);
    await q(`SYSTEM SYNC REPLICA ${DB}.rates`, r2);
    expect((await q<{ r: number }>(`SELECT dictGet('${DB}.rates_dict', 'rate', 'EUR') AS r`, r2))[0]!.r).toBe(1.1);
    // On the other replica the dictionary is as declared: nothing to send.
    const again = await apply(r2, build, { topology: "replicated" });
    expect(again.sent).toEqual([]);
    expect(again.outcome.notAttempted).toEqual([]);
  }, 300_000);
});
