/**
 * A table that is the target of a logical replication subscription (#4405),
 * against two pinned servers with `wal_level = logical`, a publisher and a
 * subscriber on one Docker network:
 *
 * - The fact the refusal rests on: a trigger made by plain `CREATE TRIGGER`
 *   does not fire for the subscription's apply worker, and one set
 *   `ENABLE ALWAYS` does.
 * - The Plan phase refuses the subscriber's table, naming the subscription,
 *   and stops refusing it once the table is out of the publication and the
 *   subscription has refreshed.
 *
 * Needs Docker; skips cleanly without it.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable } from "../testing/server";
import { connectPostgres, type PostgresClient } from "../live/client";
import { postgresMigrationPlan, type PostgresMigrationDeps } from "../../op/activities/postgres-migration";
import { postgresImage, POSTGRES_LATEST_MAJOR } from "../../spec/postgres-pin";

const run = promisify(execFile);
const enabled = await dockerAvailable();
const PASSWORD = "chant";
const suffix = `${process.pid}-${Date.now()}`;
const network = `chant-sub-net-${suffix}`;
const dir = mkdtempSync(join(tmpdir(), "chant-pg-subscriber-"));
const MARKER = { stack: "e2e", env: "test" };

interface Server {
  name: string;
  port: string;
  client: PostgresClient;
}
let pub: Server | undefined;
let sub: Server | undefined;

async function start(role: string): Promise<Server> {
  const name = `chant-sub-${role}-${suffix}`;
  await run("docker", [
    "run", "-d", "--name", name, "--network", network, "-p", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${PASSWORD}`,
    postgresImage(POSTGRES_LATEST_MAJOR), "-c", "wal_level=logical",
  ]);
  const port = (await run("docker", ["port", name, "5432/tcp"])).stdout.trim().split(":").pop()!;
  for (let i = 0; i < 120; i++) {
    try {
      const client = await connectPostgres({ url: `postgres://postgres@127.0.0.1:${port}/postgres`, password: PASSWORD });
      await client.query("SELECT 1");
      return { name, port, client };
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`${name} did not accept a connection`);
}

beforeAll(async () => {
  if (!enabled) return;
  await run("docker", ["network", "create", network]);
  [pub, sub] = await Promise.all([start("pub"), start("sub")]);
}, 600_000);

afterAll(async () => {
  for (const s of [pub, sub]) {
    await s?.client.end().catch(() => undefined);
    if (s) await run("docker", ["rm", "-f", "-v", s.name]).catch(() => undefined);
  }
  if (enabled) await run("docker", ["network", "rm", network]).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (what: string, check: () => Promise<boolean>) => {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const TABLE = "CREATE TABLE app.users (\n  id bigint PRIMARY KEY,\n  email text NOT NULL\n)";
const deps = (): PostgresMigrationDeps => ({
  config: { ownership: MARKER, sql: { profiles: { e2e: { url: `postgres://postgres@127.0.0.1:${sub!.port}/postgres`, password: { env: "PG_E2E_PASSWORD" } } } } },
  env: { PG_E2E_PASSWORD: PASSWORD },
  log: () => undefined,
});
/** The Plan phase of a rename of email to login, on the subscriber. */
function planRename(): Promise<string> {
  writeFileSync(
    join(dir, "v2.json"),
    JSON.stringify({
      dialect: "postgres",
      postgresMajor: 18,
      applyOrder: ["app", "users"],
      objects: [
        { export: "app", type: "Postgres::Schema", ddl: "CREATE SCHEMA app", dependsOn: [] },
        { export: "users", type: "Postgres::Table", dependsOn: ["app"], ddl: "CREATE TABLE app.users (\n  id bigint PRIMARY KEY,\n  login text NOT NULL -- previously: email\n)" },
      ],
    }),
  );
  return postgresMigrationPlan({ table: "app.users", column: "login", buildPath: "v2.json", environment: "e2e", stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir } as never, undefined, deps()).then(
    () => "",
    (e: unknown) => String((e as Error).message),
  );
}

describe.skipIf(!enabled)("a subscription's target table", () => {
  test("the apply worker fires an ENABLE ALWAYS trigger and not a default one", async () => {
    for (const s of [pub!, sub!]) await s.client.query(`CREATE SCHEMA app`).then(() => s.client.query(TABLE));
    await pub!.client.query("CREATE PUBLICATION pub FOR TABLE app.users");
    await sub!.client.query(`CREATE SUBSCRIPTION sub CONNECTION 'host=${pub!.name} port=5432 user=postgres password=${PASSWORD} dbname=postgres' PUBLICATION pub`);
    await waitFor("the initial sync", async () => (await sub!.client.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_subscription_rel WHERE srsubstate <> 'r'"))[0]!.n === "0");

    await sub!.client.query("ALTER TABLE app.users ADD COLUMN seen text");
    await sub!.client.query("CREATE FUNCTION app.mark() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.seen := TG_NAME; RETURN NEW; END $$");
    await sub!.client.query("CREATE TRIGGER t_default BEFORE INSERT ON app.users FOR EACH ROW EXECUTE FUNCTION app.mark()");
    await pub!.client.query("INSERT INTO app.users VALUES (1, 'a')");
    await waitFor("row 1", async () => (await sub!.client.query("SELECT 1 FROM app.users WHERE id = 1")).length === 1);
    expect(await sub!.client.query("SELECT seen FROM app.users WHERE id = 1")).toEqual([{ seen: null }]);

    await sub!.client.query("ALTER TABLE app.users ENABLE ALWAYS TRIGGER t_default");
    await pub!.client.query("INSERT INTO app.users VALUES (2, 'b')");
    await waitFor("row 2", async () => (await sub!.client.query("SELECT 1 FROM app.users WHERE id = 2")).length === 1);
    expect(await sub!.client.query("SELECT seen FROM app.users WHERE id = 2")).toEqual([{ seen: "t_default" }]);
    await sub!.client.query("DROP TRIGGER t_default ON app.users");
    await sub!.client.query("ALTER TABLE app.users DROP COLUMN seen");
  }, 300_000);

  test("the Plan phase refuses it naming the subscription, and not once the table has left the publication", async () => {
    expect(await planRename()).toMatch(/target of logical replication subscription\(s\) sub\b/);

    await pub!.client.query("ALTER PUBLICATION pub DROP TABLE app.users");
    await sub!.client.query("ALTER SUBSCRIPTION sub REFRESH PUBLICATION");
    await waitFor("the table to leave the subscription", async () => (await sub!.client.query("SELECT 1 FROM pg_subscription_rel")).length === 0);
    expect(await planRename()).not.toMatch(/subscription/);
  }, 300_000);
});
