/**
 * Access control against a server (#3682): a role, a user, a row policy and
 * grants.
 *
 * On a single node:
 *
 * - a user declared with a password is the environment's to create, and is
 *   not attempted until it exists; once it does, the apply makes the rest
 *   of it as declared and leaves its password alone;
 * - the role, the row policy and the grants are created; the plan is then
 *   clean and the deep read reports no drift, although the server prints
 *   the policy's condition and the grants its own way;
 * - a privilege granted by hand to a declared grantee is SQLCH274 and is
 *   revoked, a declared one revoked by hand is SQLCH273 and is granted
 *   again, a changed role setting is SQLCH270, a changed policy SQLCH272;
 * - the row policy filters rows for the user;
 * - with a profile that does not manage access (no `access: true`, #3716),
 *   none of it is applied, planned or read: each access declaration is
 *   reported filtered, and a hand change to a grant is not undone.
 *
 * Beside a Replicated database (two replicas of the pinned server in
 * Docker): access control is in no database, so the database's log does not
 * carry it; with no cluster named, each replica's apply makes it there.
 *
 * The single node: `CLICKHOUSE_URL` (with `CLICKHOUSE_USER` and
 * `CLICKHOUSE_PASSWORD`) names a running one, such as the one
 * `chant emulator up --lexicon sql` starts. Without it, a throwaway server
 * at the pin, skipped cleanly when Docker is not available. Users and roles
 * are global to the server, so the test names everything `chant_e2e_3716_access*`
 * and drops it afterwards.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchCluster, startScratchServer, type ScratchCluster, type ScratchServer } from "../container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { database, grant, policy, role, table, user } from "../entities";
import { planAgainstServer } from "../plan/commands";
import { observeResourcesDeep, sqlDeepNormalizationHooks } from "../plan/deep";
import { describeResources } from "./describe-resources";
import { clickhouseApply } from "../../op/activities/clickhouse-apply";

const DB = "chant_e2e_3716_access";
const READER = `${DB}_reader`;
const APP = `${DB}_app`;
const fromEnv = process.env.CLICKHOUSE_URL;
const docker = await dockerAvailable();
const enabled = fromEnv !== undefined || docker;
let server: ScratchServer | undefined;
let endpoint: ClickHouseEndpoint;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-access-"));
const q = <T = Record<string, unknown>>(sql: string, at: ClickHouseEndpoint = endpoint) => clickhouseQuery<T>(at, sql);
const cleanup = async (at: ClickHouseEndpoint) => {
  for (const sql of [`DROP ROW POLICY IF EXISTS ${DB}_tenant ON ${DB}.events`, `DROP USER IF EXISTS ${APP}`, `DROP ROLE IF EXISTS ${READER}`, `DROP DATABASE IF EXISTS ${DB} SYNC`]) {
    await q(sql, at).catch(() => undefined);
  }
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
    server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-access" });
    endpoint = server.endpoint;
  }
  await cleanup(endpoint);
}, 600_000);

afterAll(async () => {
  if (enabled) await cleanup(endpoint);
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const envOf = (at: ClickHouseEndpoint) => ({
  ...(at.user ? { CH_USER: at.user } : {}),
  ...(at.password ? { CH_PASSWORD: at.password } : {}),
});

/** The `test` profile: the server, and whether it manages access (#3716). */
const configOf = (at: ClickHouseEndpoint, opts: { topology?: string; access?: boolean } = {}) => ({
  ownership: { stack: "e2e3682", env: "test" },
  sql: {
    profiles: {
      test: {
        url: at.url,
        ...(at.user ? { user: { env: "CH_USER" } } : {}),
        ...(at.password ? { password: { env: "CH_PASSWORD" } } : {}),
        ...(opts.topology ? { topology: opts.topology } : {}),
        ...(opts.access !== false ? { access: true } : {}),
      },
    },
  },
}) as never;

type Entity = { entityType: string; props: { ddl: string }; dependsOn?: unknown };
function writeBuild(file: string, declared: Record<string, Entity>): string {
  const path = join(dir, file);
  const objects = Object.entries(declared).map(([k, e]) => ({ export: k, type: e.entityType, ddl: e.props.ddl, dependsOn: [] }));
  writeFileSync(path, JSON.stringify({ dialect: "clickhouse", applyOrder: objects.map((o) => o.export), objects }));
  return path;
}

async function apply(at: ClickHouseEndpoint, buildPath: string, opts: { topology?: string; access?: boolean } = {}) {
  const sent: string[] = [];
  const outcome = await clickhouseApply({ buildPath, environment: "test" }, undefined, {
    config: configOf(at, opts),
    env: envOf(at),
    log: (l) => void (/^[A-Z]+ /.test(l) && sent.push(l)),
  });
  return { outcome, sent };
}

const compared = (props: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(props)) as Record<string, unknown>).filter(([k]) => !sqlDeepNormalizationHooks.prune!({ pattern: k } as never)));

function declarations(opts: { memory?: string; tenant?: string } = {}) {
  const shop = database([`CREATE DATABASE ${DB}`] as unknown as TemplateStringsArray);
  const events = table([`CREATE TABLE ${DB}.events (id UInt64, tenant String) ENGINE = MergeTree ORDER BY id`] as unknown as TemplateStringsArray);
  const reader = role([`CREATE ROLE ${READER} SETTINGS max_memory_usage = ${opts.memory ?? "1000000000"}`] as unknown as TemplateStringsArray);
  const app = user([`CREATE USER ${APP} HOST ANY DEFAULT ROLE ${READER} DEFAULT DATABASE ${DB}`] as unknown as TemplateStringsArray);
  const tenant = policy([`CREATE ROW POLICY ${DB}_tenant ON ${DB}.events USING tenant='${opts.tenant ?? "a"}' AND id+0>0 TO ${READER}`] as unknown as TemplateStringsArray);
  const readEvents = grant([`GRANT SELECT(id, tenant) ON ${DB}.events TO ${READER}`] as unknown as TemplateStringsArray);
  const readerToApp = grant([`GRANT ${READER} TO ${APP}`] as unknown as TemplateStringsArray);
  return { shop, events, reader, app, tenant, readEvents, readerToApp };
}

describe.skipIf(!enabled)("access control on a single node (#3682)", () => {
  test("a user with a password waits for the environment; the rest is created, planned clean, kept as declared", async () => {
    const v1 = declarations();
    const build = writeBuild("v1.json", v1);
    const first = await apply(endpoint, build);
    expect(first.outcome.failed).toEqual([]);
    expect(first.outcome.notAttempted).toEqual([
      expect.objectContaining({ name: `user ${APP}`, reason: "filtered", detail: expect.stringMatching(/password is the environment's/) }),
      expect.objectContaining({ name: `grants ${APP}`, reason: "dependency-failed" }),
    ]);
    expect(first.outcome.applied.map((a) => [a.name, a.action])).toEqual([
      [DB, "created"],
      [`${DB}.events`, "created"],
      [`role ${READER}`, "created"],
      [`row policy ${DB}_tenant ON ${DB}.events`, "created"],
      [`grants ${READER}`, "created"],
    ]);

    // The environment creates the user with its password; the next apply makes the rest of it as declared.
    await q(`CREATE USER ${APP} IDENTIFIED WITH sha256_password BY 'chant-e2e'`);
    const second = await apply(endpoint, build);
    expect(second.outcome.failed).toEqual([]);
    expect(second.sent).toEqual([
      `ALTER USER \`${APP}\` DEFAULT DATABASE ${DB}`,
      `GRANT \`${READER}\` TO \`${APP}\``,
      // A default role must be held first.
      `ALTER USER \`${APP}\` DEFAULT ROLE ${READER}`,
    ]);
    expect((await q<{ s: string }>(`SELECT auth_type[1] AS s FROM system.users WHERE name = '${APP}'`))[0]!.s).toBe("sha256_password");

    // The server prints the policy's condition and the grants its own way: still the declarations.
    const diff = await planAgainstServer("test", build, { config: configOf(endpoint), env: envOf(endpoint) });
    expect(diff.changes).toEqual([]);
    const entities = new Map(Object.entries(v1).map(([k, e]) => [k, { entityType: e.entityType, props: e.props as unknown as Record<string, unknown> }]));
    const deep = await observeResourcesDeep({ environment: "test", entityNames: [...entities.keys()], entities, config: configOf(endpoint), env: envOf(endpoint) });
    expect(Object.keys(deep.unobserved ?? {}).sort()).toEqual(["readEvents", "readerToApp"]);
    for (const k of ["reader", "app", "tenant"] as const) expect(compared(deep.resources[k]!.properties), k).toEqual(compared(v1[k].props));

    // The policy filters rows for the user.
    await q(`INSERT INTO ${DB}.events VALUES (1, 'a'), (2, 'b'), (3, 'a')`);
    const asApp = { ...endpoint, user: APP, password: "chant-e2e" };
    expect(Number((await q<{ n: string }>(`SELECT count() AS n FROM ${DB}.events`, asApp))[0]!.n)).toBe(2);

    // Changed by hand: a privilege granted, a declared one revoked. Changed in the declaration: a setting and the condition.
    await q(`GRANT INSERT ON ${DB}.events TO ${READER}`);
    await q(`REVOKE ${READER} FROM ${APP}`);
    const v2 = declarations({ memory: "2000000000", tenant: "b" });
    const planned = await planAgainstServer("test", writeBuild("v2.json", v2), { config: configOf(endpoint), env: envOf(endpoint) });
    expect(planned.changes.map((c) => [c.object, c.field, c.rule])).toEqual([
      [`reader (role ${READER})`, "settings", "SQLCH270"],
      // Revoking the role took it off the user's default roles too.
      [`app (user ${APP})`, "defaultRole", "SQLCH271"],
      [`tenant (row policy ${DB}_tenant ON ${DB}.events)`, "using", "SQLCH272"],
      [`grants ${READER}`, `grants.INSERT ON ${DB}.events`, "SQLCH274"],
      [`grants ${APP}`, `grants.ROLE ${READER}`, "SQLCH273"],
    ]);
    const third = await apply(endpoint, writeBuild("v2.json", v2));
    expect(third.outcome.failed).toEqual([]);
    expect(third.sent).toEqual([
      `ALTER ROLE \`${READER}\` SETTINGS max_memory_usage = 2000000000`,
      `CREATE ROW POLICY OR REPLACE ${DB}_tenant ON ${DB}.events USING tenant='b' AND id+0>0 TO ${READER}`,
      `REVOKE INSERT ON \`${DB}\`.\`events\` FROM \`${READER}\``,
      `GRANT \`${READER}\` TO \`${APP}\``,
      `ALTER USER \`${APP}\` DEFAULT ROLE ${READER}`,
    ]);
    expect((await planAgainstServer("test", writeBuild("v2.json", v2), { config: configOf(endpoint), env: envOf(endpoint) })).changes).toEqual([]);
    expect(Number((await q<{ n: string }>(`SELECT count() AS n FROM ${DB}.events`, asApp))[0]!.n)).toBe(1);

    // A profile that does not manage access (#3716): nothing access-related is read, planned or applied.
    await q(`GRANT INSERT ON ${DB}.events TO ${READER}`);
    const off = { access: false };
    const v3 = declarations({ memory: "3000000000", tenant: "a" });
    const offBuild = writeBuild("v3.json", v3);
    const offPlan = await planAgainstServer("test", offBuild, { config: configOf(endpoint, off), env: envOf(endpoint) });
    expect(offPlan.changes).toEqual([]);
    expect(offPlan.hints).toContain("5 access declarations are not planned: test's profile does not manage access (sql.profiles.<env>.access)");
    const offApply = await apply(endpoint, offBuild, off);
    expect(offApply.outcome.failed).toEqual([]);
    expect(offApply.sent).toEqual([]);
    expect(offApply.outcome.notAttempted.map((n) => [n.name, n.reason])).toEqual([
      [`role ${READER}`, "filtered"],
      [`user ${APP}`, "filtered"],
      [`row policy ${DB}_tenant ON ${DB}.events`, "filtered"],
      [`grants ${READER}`, "filtered"],
      [`grants ${APP}`, "filtered"],
    ]);
    expect((await q<{ s: string }>(`SHOW GRANTS FOR ${READER}`)).map((r) => Object.values(r)[0]).join("\n")).toMatch(/GRANT INSERT\b.* ON chant_e2e_3716_access\.events TO/);
    const v3entities = new Map(Object.entries(v3).map(([k, e]) => [k, { entityType: e.entityType, props: e.props as unknown as Record<string, unknown> }]));
    const offDeep = await observeResourcesDeep({ environment: "test", entityNames: [...v3entities.keys()], entities: v3entities, config: configOf(endpoint, off), env: envOf(endpoint) });
    expect(Object.entries(offDeep.unobserved ?? {}).map(([k, u]) => [k, u.reason]).sort()).toEqual(
      ["app", "readEvents", "reader", "readerToApp", "tenant"].map((k) => [k, "filtered"]),
    );
    const offThin = await describeResources({ environment: "test", entityNames: [...v3entities.keys()], entities: v3entities, config: configOf(endpoint, off), env: envOf(endpoint) });
    expect(Object.keys(offThin.unobserved ?? {}).sort()).toEqual(["app", "readEvents", "reader", "readerToApp", "tenant"]);
  }, 300_000);
});

describe.skipIf(!docker)("access control beside a Replicated database (#3682)", () => {
  let cluster: ScratchCluster | undefined;
  beforeAll(async () => {
    cluster = await startScratchCluster(clickhouseImage(), { replicas: 2, namePrefix: "chant-sql-access-repl" });
  }, 600_000);
  afterAll(async () => {
    await cluster?.stop();
  });

  test("each replica's apply makes it there, with no ON CLUSTER, and the next apply sends nothing", async () => {
    const [r1, r2] = cluster!.replicas as [ClickHouseEndpoint, ClickHouseEndpoint];
    const { shop, events, reader, tenant, readEvents } = declarations();
    const build = writeBuild("repl.json", { shop, events, reader, tenant, readEvents });
    const first = await apply(r1, build, { topology: "replicated" });
    expect(first.outcome.failed).toEqual([]);
    expect(first.sent.join("\n")).not.toMatch(/ON CLUSTER/);
    await q(first.sent[0]!, r2);
    await q(`SYSTEM SYNC DATABASE REPLICA ${DB}`, r2);
    const second = await apply(r2, build, { topology: "replicated" });
    expect(second.outcome.failed).toEqual([]);
    expect(second.outcome.applied.filter((a) => a.action === "created").map((a) => a.name)).toEqual([
      `role ${READER}`,
      `row policy ${DB}_tenant ON ${DB}.events`,
      `grants ${READER}`,
    ]);
    for (const at of [r1, r2]) {
      expect(Number((await q<{ n: string }>(`SELECT count() AS n FROM system.row_policies WHERE short_name = '${DB}_tenant'`, at))[0]!.n)).toBe(1);
      expect((await apply(at, build, { topology: "replicated" })).sent).toEqual([]);
    }
  }, 300_000);
});
