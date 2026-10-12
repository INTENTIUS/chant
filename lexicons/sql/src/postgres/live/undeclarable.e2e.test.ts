/**
 * Import against a real Postgres server never leaves an object out without a
 * word (#3911): a database holding a composite type, an aggregate, a
 * collation, a cast and an event trigger beside a table fails the import,
 * which names all five; with `skipUndeclarable` the table is imported and
 * the five are warnings. What an extension brings (hstore's casts and
 * operators) is the extension's, and is not refused.
 *
 * Needs Docker; skips cleanly without it. One throwaway `postgres` container
 * at the pin, removed afterwards even on failure.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { exportResources } from "../import/live-export";
import { UndeclarableObjectsError } from "../../core/undeclarable";

const enabled = await dockerAvailable();
let server: TestPostgres | undefined;

const SEED = `
CREATE EXTENSION hstore WITH SCHEMA public;
CREATE SCHEMA app;
CREATE TABLE app.users (id bigint PRIMARY KEY, name text);
CREATE TYPE app.pair AS (a integer, b text);
CREATE FUNCTION app.add2(integer, integer) RETURNS integer LANGUAGE sql AS $$ SELECT $1 + $2 $$;
CREATE AGGREGATE app.total(integer) (sfunc = app.add2, stype = integer, initcond = '0');
CREATE COLLATION app.ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
CREATE FUNCTION app.pair_text(app.pair) RETURNS text LANGUAGE sql AS $$ SELECT ($1).b $$;
CREATE CAST (app.pair AS text) WITH FUNCTION app.pair_text(app.pair);
CREATE FUNCTION app.on_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE EVENT TRIGGER audit_ddl ON ddl_command_end EXECUTE FUNCTION app.on_ddl();
`;

beforeAll(async () => {
  if (!enabled) return;
  server = await startTestPostgres();
  const admin = await server.connect();
  await admin.query("CREATE DATABASE source");
  await admin.end();
  const source = await server.connect("source");
  await source.query(SEED);
  await source.end();
}, 600_000);

afterAll(async () => {
  await server?.stop();
});

const profile = () => ({
  config: { sql: { profiles: { src: { url: server!.endpoint("source").url, password: { env: "PG_UD_PASSWORD" } } } } },
  env: { PG_UD_PASSWORD: server!.endpoint("source").password },
});

const NAMED = [
  "aggregate app.total(integer)",
  "cast (app.pair AS text)",
  "collation app.ci",
  "event trigger audit_ddl",
  "composite type app.pair",
];

describe.skipIf(!enabled)("importing a database with objects chant cannot declare", () => {
  test("fails, naming every one of them", async () => {
    const err = await exportResources({ environment: "src", ...profile() }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UndeclarableObjectsError);
    const objects = (err as UndeclarableObjectsError).objects.map((o) => `${o.kind} ${o.schema ? `${o.schema}.` : ""}${o.name}`);
    expect([...objects].sort()).toEqual([...NAMED].sort());
    for (const line of NAMED) expect((err as Error).message).toContain(`  - ${line}\n`);
  }, 120_000);

  test("with skipUndeclarable, imports the rest and lists them as warnings", async () => {
    const ir = await exportResources({ environment: "src", skipUndeclarable: true, ...profile() });
    expect(ir.resources.map((r) => r.properties.name)).toEqual(expect.arrayContaining(["users", "hstore", "add2", "pair_text", "on_ddl"]));
    const left = (ir.warnings ?? []).filter((w) => w.includes("is left out (--skip-undeclarable)"));
    expect(left.map((w) => w.split(" is left out")[0]).sort()).toEqual([...NAMED].sort());
  }, 120_000);
});
