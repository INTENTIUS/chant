/**
 * Renames the Op refused in #3322 and makes since (#3331), against the
 * pinned server:
 *
 * - A rename of a column with a default (`defaultAtContract`): writers of
 *   either name during the migration, the new column without the default
 *   until the contract, and the default there once it ends.
 * - A rename of a `serial` column: the sequence stays on the old column
 *   until the contract and is handed to the new one there.
 * - A rename of an identity column: the identity moves to the new column at
 *   the contract and carries on where the old one stood.
 * - A rename with a type change (`reverse`): writers of either name, and a
 *   `reverse` that does not give the old value back fails the verification.
 *
 * Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OpRunFailure } from "@intentius/chant/op";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { ApprovingLedger, runMigrationOp } from "../testing/migration";
import type { PostgresClient } from "../live/client";
import { planPgAgainstServer } from "../plan/commands";
import { postgresApply } from "../../op/activities/postgres-apply";
import { postgresMigrationPlan, type PostgresMigrationDeps } from "../../op/activities/postgres-migration";
import type { PostgresMigrationOpConfig } from "./op";

const enabled = await dockerAvailable();
let server: TestPostgres | undefined;
let admin: PostgresClient | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-pg-followups-"));

beforeAll(async () => {
  if (!enabled) return;
  server = await startTestPostgres();
  admin = await server.connect();
}, 600_000);

afterAll(async () => {
  await admin?.end();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Obj {
  export: string;
  type: string;
  ddl: string;
  dependsOn?: string[];
}

function writeBuild(file: string, objects: Obj[]): string {
  writeFileSync(join(dir, file), JSON.stringify({ dialect: "postgres", postgresMajor: 18, applyOrder: objects.map((o) => o.export), objects: objects.map((o) => ({ dependsOn: [], ...o })) }));
  return file;
}

const MARKER = { stack: "e2e", env: "test" };
const profile = () => ({
  config: { ownership: MARKER, sql: { profiles: { e2e: { url: server!.endpoint().url, password: { env: "PG_E2E_PASSWORD" } } } } },
  env: { PG_E2E_PASSWORD: server!.endpoint().password },
});
const deps = (): PostgresMigrationDeps => ({ ...profile(), log: () => undefined });
const apply = (file: string) => postgresApply({ buildPath: join(dir, file), environment: "e2e" }, undefined, { ...profile(), log: () => undefined });
const plan = (file: string) => planPgAgainstServer("e2e", join(dir, file), profile());
const one = async <T>(sql: string): Promise<T> => (await admin!.query<T>(sql))[0]!;
const schemaObj = (name: string): Obj => ({ export: name, type: "Postgres::Schema", ddl: `CREATE SCHEMA ${name}` });
const table = (exportName: string, schema: string, ddl: string): Obj => ({ export: exportName, type: "Postgres::Table", dependsOn: [schema], ddl });
/** A table of a `bigint` key and one more column, last, with the `-- previously:` hint a rename is declared by. */
const keyed = (exportName: string, schema: string, column: string, previously?: string): Obj =>
  table(exportName, schema, `CREATE TABLE ${schema}.${exportName} (\n  id bigint PRIMARY KEY,\n  ${column}${previously ? ` -- previously: ${previously}` : ""}\n)`);
const config = (over: Pick<PostgresMigrationOpConfig, "name" | "table" | "column" | "output"> & Partial<PostgresMigrationOpConfig>): PostgresMigrationOpConfig => ({
  env: "e2e",
  build: false,
  path: dir,
  retain: "0s",
  stack: MARKER.stack,
  ownershipEnv: MARKER.env,
  ...over,
});
const refusal = (tableName: string, column: string, output: string, extra: Partial<PostgresMigrationOpConfig> = {}) =>
  postgresMigrationPlan({ table: tableName, column, buildPath: output, environment: "e2e", stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir, ...extra } as never, undefined, deps()).then(
    () => "",
    (e: unknown) => String((e as Error).message),
  );
const defaultOf = async (t: string, c: string) =>
  (await one<{ d: string | null }>(`SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS d FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = '${t}'::regclass AND a.attname = '${c}'`)).d;

/** Run the Op until it is done, approving each gate; `atGate` runs after the first run, with both columns written and nothing switched. */
async function runToEnd(c: PostgresMigrationOpConfig, atGate?: () => Promise<void>) {
  const ledger = new ApprovingLedger();
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const r = await runMigrationOp(c, ledger.port, deps);
    runs.push(r);
    if (i === 0) await atGate?.();
    if (r.status !== "gated") break;
    ledger.approveLast();
  }
  return runs;
}

describe.skipIf(!enabled)("a rename of a column with a default", () => {
  const DF = schemaObj("df");
  const users = (c: string, previously?: string) => keyed("users", "df", `${c} text NOT NULL DEFAULT 'none'`, previously);

  test("refused without defaultAtContract; with it, writers of either name agree and the default lands at the contract", async () => {
    await apply(writeBuild("df-v1.json", [DF, users("email")]));
    await admin!.query("INSERT INTO df.users (id, email) SELECT g, 'u' || g FROM generate_series(1, 500) g");
    writeBuild("df-v2.json", [DF, users("login", "email")]);
    expect(await refusal("df.users", "login", "df-v2.json")).toMatch(/Set defaultAtContract: true/);

    const runs = await runToEnd(config({ name: "migrate-df-login", table: "df.users", column: "login", output: "df-v2.json", defaultAtContract: true, batchSize: 200 }), async () => {
      // Nothing is switched: the new column has no default, the old one keeps its own.
      expect(await defaultOf("df.users", "login")).toBeNull();
      expect(await defaultOf("df.users", "email")).toBe("'none'::text");
      await admin!.query("INSERT INTO df.users (id) VALUES (1001)"); // neither name
      await admin!.query("INSERT INTO df.users (id, email) VALUES (1002, 'old')"); // the old name
      await admin!.query("INSERT INTO df.users (id, login) VALUES (1003, 'new')"); // the new name
      await admin!.query("UPDATE df.users SET login = 'new2' WHERE id = 1002");
      await admin!.query("UPDATE df.users SET email = 'old2' WHERE id = 1003");
    });
    expect(runs.map((r) => r.status)).toEqual(["gated", "gated", "ok"]);
    expect(await admin!.query("SELECT id::int AS id, login FROM df.users WHERE id > 1000 ORDER BY id")).toEqual([
      { id: 1001, login: "none" },
      { id: 1002, login: "new2" },
      { id: 1003, login: "old2" },
    ]);
    expect(await defaultOf("df.users", "login")).toBe("'none'::text");
    expect(await admin!.query("SELECT attname FROM pg_attribute WHERE attrelid = 'df.users'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum")).toEqual([{ attname: "id" }, { attname: "login" }]);
    expect((await plan("df-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("a rename of a serial column", () => {
  const SR = schemaObj("sq");
  const items = (c: string, previously?: string) => keyed("items", "sq", `${c} serial`, previously);

  test("the sequence stays with the old column until the contract, then belongs to the new one and stays its default", async () => {
    await apply(writeBuild("sq-v1.json", [SR, items("n")]));
    await admin!.query("INSERT INTO sq.items (id) SELECT g FROM generate_series(1, 300) g");
    writeBuild("sq-v2.json", [SR, items("num", "n")]);

    const runs = await runToEnd(config({ name: "migrate-items-num", table: "sq.items", column: "num", output: "sq-v2.json", defaultAtContract: true }), async () => {
      await admin!.query("INSERT INTO sq.items (id) VALUES (1001)"); // takes the old default; the trigger copies it
      await admin!.query("INSERT INTO sq.items (id, num) VALUES (1002, 7000)"); // the new name
      expect(await one("SELECT n = num AS same FROM sq.items WHERE id = 1001")).toEqual({ same: true });
      expect(await one("SELECT n AS n FROM sq.items WHERE id = 1002")).toEqual({ n: 7000 });
    });
    expect(runs.map((r) => r.status)).toEqual(["gated", "gated", "ok"]);
    expect(await one("SELECT pg_catalog.pg_get_serial_sequence('sq.items', 'num') AS seq")).toEqual({ seq: "sq.items_num_seq" });
    const next = await one<{ id: number; num: number }>("INSERT INTO sq.items (id) VALUES (2000) RETURNING id::int AS id, num");
    expect(next.num).toBeGreaterThan(300);
    expect((await plan("sq-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("a rename of an identity column", () => {
  const ID = schemaObj("ix");
  const things = (c: string, previously?: string) => keyed("things", "ix", `${c} integer GENERATED ALWAYS AS IDENTITY`, previously);

  test("the identity moves to the new column at the contract and carries on where the old one stood", async () => {
    await apply(writeBuild("ix-v1.json", [ID, things("n")]));
    await admin!.query("INSERT INTO ix.things (id) SELECT g FROM generate_series(1, 120) g");
    writeBuild("ix-v2.json", [ID, things("num", "n")]);

    const runs = await runToEnd(config({ name: "migrate-things-num", table: "ix.things", column: "num", output: "ix-v2.json", defaultAtContract: true }), async () => {
      await admin!.query("INSERT INTO ix.things (id) VALUES (1001)"); // the old identity gives 121; the trigger copies it
      expect(await one("SELECT n = num AS same FROM ix.things WHERE id = 1001")).toEqual({ same: true });
      // A writer of the new name gives a value; the trigger sets the old column's ALWAYS identity from it.
      await admin!.query("INSERT INTO ix.things (id, num) VALUES (1002, 5000)");
      expect(await one("SELECT n AS n FROM ix.things WHERE id = 1002")).toEqual({ n: 5000 });
    });
    expect(runs.map((r) => r.status)).toEqual(["gated", "gated", "ok"]);
    expect(await one("SELECT attidentity::text AS identity FROM pg_attribute WHERE attrelid = 'ix.things'::regclass AND attname = 'num'")).toEqual({ identity: "a" });
    const next = await one<{ num: number }>("INSERT INTO ix.things (id) VALUES (2000) RETURNING num");
    expect(next.num).toBeGreaterThan(120);
    expect((await plan("ix-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("a rename with a type change", () => {
  const RT = schemaObj("rt");
  const people = (column: string, previously?: string) => keyed("people", "rt", column, previously);

  test("refused without reverse; with it, writers of either name agree and a wrong reverse fails the verification", async () => {
    await apply(writeBuild("rt-v1.json", [RT, people("age_text text NOT NULL")]));
    await admin!.query("INSERT INTO rt.people SELECT g, (g % 90)::text FROM generate_series(1, 400) g");
    writeBuild("rt-v2.json", [RT, people("age integer NOT NULL", "age_text")]);
    expect(await refusal("rt.people", "age", "rt-v2.json")).toMatch(/give that expression as reverse/);

    // A reverse that does not give the old value back: nothing is switched and onFailure drops what the expand added.
    const bad = await runMigrationOp(config({ name: "migrate-people-age", table: "rt.people", column: "age", output: "rt-v2.json", using: "CAST(age_text AS integer)", reverse: "CAST(age AS text) || 'x'" }), new ApprovingLedger().port, deps).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(bad).toBeInstanceOf(OpRunFailure);
    expect((bad as OpRunFailure).result.records.find((x) => x.fn === "postgresMigrationVerify")?.error).toMatch(/must give the old value back/);
    expect(await one("SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'rt.people'::regclass AND attname = 'age' AND NOT attisdropped")).toEqual({ n: 0 });
    // The backfill wrote the new column only: the old one is as it was, not rewritten through the wrong reverse.
    expect(await one("SELECT count(*)::int AS n FROM rt.people WHERE age_text IS DISTINCT FROM (id % 90)::text")).toEqual({ n: 0 });

    const runs = await runToEnd(config({ name: "migrate-people-age", table: "rt.people", column: "age", output: "rt-v2.json", using: "CAST(age_text AS integer)", reverse: "CAST(age AS text)" }), async () => {
      await admin!.query("INSERT INTO rt.people (id, age_text) VALUES (1001, '41')"); // the old name
      await admin!.query("INSERT INTO rt.people (id, age) VALUES (1002, 42)"); // the new name
      await admin!.query("UPDATE rt.people SET age = 43 WHERE id = 1001");
      await admin!.query("UPDATE rt.people SET age_text = '44' WHERE id = 1002");
      expect(await admin!.query("SELECT id::int AS id, age, age_text FROM rt.people WHERE id > 1000 ORDER BY id")).toEqual([
        { id: 1001, age: 43, age_text: "43" },
        { id: 1002, age: 44, age_text: "44" },
      ]);
    });
    expect(runs.map((r) => r.status)).toEqual(["gated", "gated", "ok"]);
    expect(await one("SELECT pg_catalog.format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'rt.people'::regclass AND attname = 'age'")).toEqual({ t: "integer" });
    expect(await admin!.query("SELECT attname FROM pg_attribute WHERE attrelid = 'rt.people'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum")).toEqual([{ attname: "id" }, { attname: "age" }]);
    expect((await plan("rt-v2.json")).changes).toEqual([]);
  }, 300_000);

  test("a reverse that loses something ('007' -> 7 -> '7') fails the verification and leaves the old column as it was", async () => {
    const LR = schemaObj("lr");
    const codes = (column: string, previously?: string) => keyed("codes", "lr", column, previously);
    await apply(writeBuild("lr-v1.json", [LR, codes("code_text text NOT NULL")]));
    await admin!.query("INSERT INTO lr.codes VALUES (1, '007'), (2, '42')");
    writeBuild("lr-v2.json", [LR, codes("code integer NOT NULL", "code_text")]);

    const lossy = await runMigrationOp(config({ name: "migrate-codes-code", table: "lr.codes", column: "code", output: "lr-v2.json", using: "CAST(code_text AS integer)", reverse: "CAST(code AS text)" }), new ApprovingLedger().port, deps).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(lossy).toBeInstanceOf(OpRunFailure);
    expect((lossy as OpRunFailure).result.records.find((x) => x.fn === "postgresMigrationVerify")?.error).toMatch(/1 of 2 row\(s\) have code_text different/);
    expect(await admin!.query("SELECT id::int AS id, code_text FROM lr.codes ORDER BY id")).toEqual([
      { id: 1, code_text: "007" },
      { id: 2, code_text: "42" },
    ]);
  }, 300_000);
});
