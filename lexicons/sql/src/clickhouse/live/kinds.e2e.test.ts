/**
 * The ClickHouse kinds #3911 adds, against the pinned server: quotas,
 * settings profiles, a table over a table function, and a refreshable
 * materialized view and a table's skip index and projection as the server
 * prints them back.
 *
 * Each round-trips: declared in a source file, built, applied, and then
 * planned with no change; imported back from the server (`exportResources`
 * for the schema, `SHOW CREATE` through a `.sql` file for access control,
 * which an import never reads on its own), built again, and planned with no
 * change. A change to each takes the statement its rule says: `ALTER QUOTA`
 * and `ALTER SETTINGS PROFILE`, never `OR REPLACE`, so a profile that
 * inherits a changed one keeps it; `CREATE OR REPLACE TABLE` for the table
 * over a table function.
 *
 * Needs Docker; skips cleanly without it. A throwaway server at the pin.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { exportResources } from "../import/live-export";
import { ClickHouseGenerator } from "../import/generator";
import { ClickHouseSqlParser } from "../import/parser";
import { readLiveAccess } from "./catalog";
import { planAgainstServer } from "../plan/commands";
import { observeResourcesDeep, sqlDeepNormalizationHooks } from "../plan/deep";
import { clickhouseApply } from "../../op/activities/clickhouse-apply";
import { sqlPlugin } from "../../plugin";
import { sqlSerializer } from "../../serializer";

const DB = "chant_e2e_3911";
const enabled = await dockerAvailable();
let server: ScratchServer | undefined;
let endpoint: ClickHouseEndpoint;
const root = join(import.meta.dirname, "..", "..", "..", `.kinds-tmp-${process.pid}`);
const q = <T = Record<string, unknown>>(sql: string) => clickhouseQuery<T>(endpoint, sql);

beforeAll(async () => {
  if (!enabled) return;
  server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-kinds" });
  endpoint = server.endpoint;
}, 600_000);

afterAll(async () => {
  await server?.stop();
  rmSync(root, { recursive: true, force: true });
});

const config = () =>
  ({ ownership: { stack: "e2e3911", env: "test" }, sql: { profiles: { test: { url: endpoint.url, access: true } } } }) as never;

/** A project of these files, built: the build document's path and the entities. */
async function buildProject(name: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["sql"] };\n');
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, "src", file), content);
  const result = await build(join(dir, "src"), [sqlSerializer], undefined, { fold: true, intrinsics: sqlPlugin.intrinsics!(), lexicons: ["sql"] });
  expect(result.errors).toEqual([]);
  const buildPath = join(dir, "build.json");
  writeFileSync(buildPath, (result.outputs.get("sql") as SerializerResult).primary);
  const entities = new Map([...result.entities].map(([k, v]) => [k, { entityType: v.entityType, props: (v as unknown as { props: Record<string, unknown> }).props }]));
  return { buildPath, entities };
}

async function apply(buildPath: string) {
  const sent: string[] = [];
  const outcome = await clickhouseApply({ buildPath, environment: "test" }, undefined, { config: config(), env: {}, log: (l) => void (/^[A-Z]+ /.test(l) && sent.push(l)) });
  expect(outcome.failed).toEqual([]);
  return { outcome, sent };
}

const plan = async (buildPath: string) => (await planAgainstServer("test", buildPath, { config: config(), env: {} })).changes.map((c) => [c.object, c.field, c.rule]);

const compared = (props: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(props)) as Record<string, unknown>).filter(([k]) => !sqlDeepNormalizationHooks.prune!({ pattern: k } as never)));

const source = (v: { limit: number; threads: number; nums: number }) => `import { database, table, view, role, quota, settingsProfile } from "@intentius/chant-lexicon-sql/clickhouse";

export const shop = database\`CREATE DATABASE ${DB}\`;

export const events = table\`
  CREATE TABLE \${shop}.events (
    id UInt64,
    kind LowCardinality(String),
    INDEX by_kind kind TYPE bloom_filter(0.01) GRANULARITY 4,
    PROJECTION per_kind (SELECT kind, count() GROUP BY kind)
  ) ENGINE = MergeTree ORDER BY id\`;

export const hourly = view\`
  CREATE MATERIALIZED VIEW \${shop}.hourly REFRESH EVERY 1 HOUR
  ENGINE = MergeTree ORDER BY kind
  AS SELECT kind, count() AS n FROM \${events} GROUP BY kind\`;

export const nums = table\`CREATE TABLE \${shop}.nums AS numbers(${v.nums})\`;
export const typedNums = table\`CREATE TABLE \${shop}.typed_nums (number UInt64) AS numbers(10) COMMENT 'counted'\`;

export const reader = role\`CREATE ROLE ${DB}_reader\`;

export const base = settingsProfile\`CREATE SETTINGS PROFILE ${DB}_base SETTINGS max_threads = ${v.threads}\`;

export const analysts = settingsProfile\`
  CREATE PROFILE ${DB}_analysts
  SETTINGS PROFILE \${base}, max_memory_usage = 10000000000 MIN 1000000 MAX 20000000000, readonly = 1 READONLY
  TO \${reader}\`;

export const perUser = quota\`
  CREATE QUOTA ${DB}_per_user KEYED BY 'user_name'
  FOR INTERVAL 60 MINUTE MAX QUERIES ${v.limit}, errors = 50,
  FOR RANDOMIZED INTERVAL 1 DAY MAX read_bytes = 1e12
  TO \${reader}\`;
`;

describe.skipIf(!enabled)("the kinds #3911 adds, against the pinned server", () => {
  test("declared, built, applied, planned clean; imported back and planned clean; changed with the statement each rule says", async () => {
    const v1 = await buildProject("v1", { "schema.ts": source({ limit: 1000, threads: 4, nums: 10 }) });
    const first = await apply(v1.buildPath);
    expect(first.outcome.applied.filter((a) => a.action === "created").map((a) => a.name)).toEqual(
      expect.arrayContaining([`${DB}.events`, `${DB}.hourly`, `${DB}.nums`, `${DB}.typed_nums`, `quota ${DB}_per_user`, `settings profile ${DB}_base`, `settings profile ${DB}_analysts`]),
    );
    expect(await plan(v1.buildPath)).toEqual([]);

    // The deep read: every declared object read back as declared.
    const deep = await observeResourcesDeep({ environment: "test", entityNames: [...v1.entities.keys()], entities: v1.entities, config: config(), env: {} });
    expect(deep.unobserved ?? {}).toEqual({});
    for (const k of ["perUser", "base", "analysts", "nums", "typedNums", "hourly", "events"]) {
      expect(compared(deep.resources[k]!.properties), k).toEqual(compared(v1.entities.get(k)!.props));
    }

    // Imported back: the schema from the catalog, access control from SHOW CREATE in a .sql file.
    const exported = await exportResources({ environment: "test", config: config(), env: {} });
    const [schemaFile] = new ClickHouseGenerator().generate(exported);
    const access = await readLiveAccess({ endpoint, source: "test", defaultDatabase: "default" }, [
      { kind: "role", name: `${DB}_reader` },
      { kind: "settingsProfile", name: `${DB}_base` },
      { kind: "settingsProfile", name: `${DB}_analysts` },
      { kind: "quota", name: `${DB}_per_user` },
    ]);
    expect(access.map((a) => a.statement)).toEqual([
      `CREATE ROLE ${DB}_reader`,
      `CREATE QUOTA ${DB}_per_user KEYED BY user_name FOR INTERVAL 1 hour MAX queries = 1000, errors = 50, FOR RANDOMIZED INTERVAL 1 day MAX read_bytes = 1000000000000 TO ${DB}_reader`,
      `CREATE SETTINGS PROFILE \`${DB}_base\` SETTINGS max_threads = 4`,
      `CREATE SETTINGS PROFILE \`${DB}_analysts\` SETTINGS INHERIT \`${DB}_base\`, max_memory_usage = 10000000000 MIN 1000000 MAX 20000000000, readonly = 1 CONST TO ${DB}_reader`,
    ]);
    const [accessFile] = new ClickHouseGenerator().generate(new ClickHouseSqlParser().parse(access.map((a) => `${a.statement};`).join("\n")));
    expect(schemaFile!.content).toMatch(/CREATE TABLE \$\{\w+\}\.nums\s*\(\s*number UInt64\s*\) AS numbers\(10\)/);
    expect(schemaFile!.content).toContain("REFRESH EVERY 1 HOUR");
    const imported = await buildProject("imported", { "schema.ts": schemaFile!.content, "access.ts": accessFile!.content });
    expect(await plan(imported.buildPath)).toEqual([]);
    expect((await apply(imported.buildPath)).sent).toEqual([]);

    // Changed: a quota's limit, the inherited profile's settings, the table function's call.
    const v2 = await buildProject("v2", { "schema.ts": source({ limit: 2000, threads: 2, nums: 20 }) });
    expect(await plan(v2.buildPath)).toEqual([
      [`base (settings profile ${DB}_base)`, "settings", "SQLCH276"],
      [`nums (${DB}.nums)`, "asFunction", "SQLCH219"],
      [`perUser (quota ${DB}_per_user)`, "interval.3600", "SQLCH275"],
    ]);
    const second = await apply(v2.buildPath);
    expect(second.sent).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^CREATE OR REPLACE TABLE ${DB}\\.nums AS numbers\\(20\\) COMMENT '`)),
        `ALTER QUOTA \`${DB}_per_user\` FOR INTERVAL 3600 second MAX errors = 50, queries = 2000`,
        `ALTER SETTINGS PROFILE \`${DB}_base\` SETTINGS max_threads = 2`,
      ]),
    );
    expect(second.sent).toHaveLength(3);
    expect(await plan(v2.buildPath)).toEqual([]);
    // ALTER, not OR REPLACE: the profile that inherits the changed one still does.
    expect(Object.values((await q<Record<string, string>>(`SHOW CREATE SETTINGS PROFILE ${DB}_analysts`))[0]!)[0]).toContain(`INHERIT \`${DB}_base\``);
    expect(Number((await q<{ n: string }>(`SELECT count() AS n FROM ${DB}.nums`))[0]!.n)).toBe(20);
  }, 600_000);
});
