/**
 * SQL user-defined functions against a server (#3682).
 *
 * On a single node: a declared function is created as declared, plans with
 * no changes although the server prints its expression its own way, and
 * reads back with no drift; a changed expression is SQLCH260 and the apply
 * replaces it; a function the build does not declare is never read, so
 * never listed or dropped.
 *
 * Beside a Replicated database (two replicas of the pinned server in
 * Docker): a function belongs to no database, so the database's log does
 * not carry it. With no cluster named, each replica's apply creates it
 * there, and a second apply sends nothing.
 *
 * The single node: `CLICKHOUSE_URL` (with `CLICKHOUSE_USER` and
 * `CLICKHOUSE_PASSWORD`) names a running one, such as the one
 * `chant emulator up --lexicon sql` starts. Without it, a throwaway server
 * at the pin, skipped cleanly when Docker is not available. A function is
 * global to the server, so the test names its functions `chant_e2e_3682_*`
 * and drops them afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchCluster, startScratchServer, type ScratchCluster, type ScratchServer } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { database, func, table } from "../entities";
import { planAgainstServer } from "../plan/commands";
import { observeResourcesDeep, sqlDeepNormalizationHooks } from "../plan/deep";
import { clickhouseApply } from "../../op/activities/clickhouse-apply";

const PREFIX = "chant_e2e_3682";
const LINEAR = `${PREFIX}_linear`;
const FOREIGN = `${PREFIX}_foreign`;
const fromEnv = process.env.CLICKHOUSE_URL;
const docker = await dockerAvailable();
const enabled = fromEnv !== undefined || docker;
let server: ScratchServer | undefined;
let endpoint: ClickHouseEndpoint;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-functions-"));
const q = <T = Record<string, unknown>>(sql: string, at: ClickHouseEndpoint = endpoint) => clickhouseQuery<T>(at, sql);
const cleanup = async (at: ClickHouseEndpoint) => {
  for (const f of [LINEAR, FOREIGN]) await q(`DROP FUNCTION IF EXISTS ${f}`, at).catch(() => undefined);
  await q(`DROP DATABASE IF EXISTS ${PREFIX} SYNC`, at).catch(() => undefined);
};

beforeAll(async () => {
  if (!enabled) return;
  if (fromEnv !== undefined) {
    endpoint = {
      url: fromEnv,
      ...(process.env.CLICKHOUSE_USER ? { user: process.env.CLICKHOUSE_USER } : {}),
      ...(process.env.CLICKHOUSE_PASSWORD ? { password: process.env.CLICKHOUSE_PASSWORD } : {}),
    };
  } else {
    server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-functions" });
    endpoint = server.endpoint;
  }
  await cleanup(endpoint);
}, 600_000);

afterAll(async () => {
  if (enabled) await cleanup(endpoint);
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const envOf = (at: ClickHouseEndpoint, topology?: string) => ({
  CLICKHOUSE_URL: at.url,
  ...(at.user ? { CLICKHOUSE_USER: at.user } : {}),
  ...(at.password ? { CLICKHOUSE_PASSWORD: at.password } : {}),
  ...(topology ? { CLICKHOUSE_TOPOLOGY: topology } : {}),
});

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
    config: { ownership: { stack: "e2e3682", env: "test" } },
    env: envOf(at, opts.topology),
    log: (l) => void (/^[A-Z]+ /.test(l) && sent.push(l)),
  });
  return { outcome, sent };
}

const linear = (expr: string) => func([`CREATE FUNCTION ${LINEAR} AS (x, k, b) -> ${expr}`] as unknown as TemplateStringsArray);
const compared = (props: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(props)) as Record<string, unknown>).filter(([k]) => !sqlDeepNormalizationHooks.prune!({ pattern: k } as never)));

describe.skipIf(!enabled)("a function on a single node (#3682)", () => {
  test("created, planned and read back as declared, changed, and a foreign one left alone", async () => {
    const v1 = { linear: linear("k*x + b") };
    const first = await apply(endpoint, writeBuild("v1.json", v1));
    expect(first.outcome.failed).toEqual([]);
    expect(first.sent).toEqual([`CREATE FUNCTION ${LINEAR} AS (x, k, b) -> k*x + b`]);
    expect((await q<{ y: number }>(`SELECT ${LINEAR}(2, 3, 1) AS y`))[0]!.y).toBe(7);

    // The server prints `((k * x) + b)`: its formatter says that is the declaration.
    await q(`CREATE FUNCTION ${FOREIGN} AS (x) -> x`);
    const diff = await planAgainstServer("test", writeBuild("v1.json", v1), { config: {}, env: envOf(endpoint) });
    expect(diff.changes).toEqual([]);
    const entities = new Map(Object.entries(v1).map(([k, e]) => [k, { entityType: e.entityType, props: e.props as unknown as Record<string, unknown> }]));
    const deep = await observeResourcesDeep({ environment: "test", entityNames: [...entities.keys()], entities, config: {}, env: envOf(endpoint) });
    expect(deep.unobserved ?? {}).toEqual({});
    expect(compared(deep.resources.linear!.properties)).toEqual(compared(v1.linear.props));

    const v2 = { linear: linear("k*x + b + 1") };
    const planned = await planAgainstServer("test", writeBuild("v2.json", v2), { config: {}, env: envOf(endpoint) });
    expect(planned.changes.map((c) => [c.object, c.field, c.rule])).toEqual([[`linear (function ${LINEAR})`, "lambda", "SQLCH260"]]);
    const changed = await apply(endpoint, writeBuild("v2.json", v2), { prune: true });
    expect(changed.sent).toEqual([`CREATE OR REPLACE FUNCTION ${LINEAR} AS (x, k, b) -> k*x + b + 1`]);
    expect(changed.outcome.pruned).toEqual([]);
    expect((await q<{ y: number }>(`SELECT ${LINEAR}(2, 3, 1) AS y`))[0]!.y).toBe(8);
    // The foreign function is never read, so never dropped.
    expect((await q<{ n: number }>(`SELECT count() AS n FROM system.functions WHERE name = '${FOREIGN}'`))[0]!.n).toBe(1);
  }, 300_000);
});

describe.skipIf(!docker)("a function beside a Replicated database (#3682)", () => {
  let cluster: ScratchCluster | undefined;
  beforeAll(async () => {
    cluster = await startScratchCluster(clickhouseImage(), { replicas: 2, namePrefix: "chant-sql-functions-repl" });
  }, 600_000);
  afterAll(async () => {
    await cluster?.stop();
  });

  test("each replica's apply creates it there, with no ON CLUSTER, and the next apply sends nothing", async () => {
    const [r1, r2] = cluster!.replicas as [ClickHouseEndpoint, ClickHouseEndpoint];
    const shop = database([`CREATE DATABASE ${PREFIX}`] as unknown as TemplateStringsArray);
    const rates = table([`CREATE TABLE ${PREFIX}.rates (code String, rate Float64) ENGINE = MergeTree ORDER BY code`] as unknown as TemplateStringsArray);
    const build = writeBuild("repl.json", { shop, rates, linear: linear("k*x + b") });
    const first = await apply(r1, build, { topology: "replicated" });
    expect(first.outcome.failed).toEqual([]);
    expect(first.sent.join("\n")).not.toMatch(/ON CLUSTER/);
    await q(first.sent[0]!, r2);
    await q(`SYSTEM SYNC DATABASE REPLICA ${PREFIX}`, r2);
    const second = await apply(r2, build, { topology: "replicated" });
    expect(second.sent).toEqual([`CREATE FUNCTION ${LINEAR} AS (x, k, b) -> k*x + b`]);
    expect((await q<{ y: number }>(`SELECT ${LINEAR}(2, 3, 1) AS y`, r2))[0]!.y).toBe(7);
    expect((await apply(r1, build, { topology: "replicated" })).sent).toEqual([]);
    expect((await apply(r2, build, { topology: "replicated" })).sent).toEqual([]);
  }, 300_000);
});
