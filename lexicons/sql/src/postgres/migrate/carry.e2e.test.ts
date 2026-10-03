/**
 * The migration of a column that indexes, constraints and views use
 * (#3322), against the pinned server.
 *
 * - `integer` to `bigint` on a primary key another table references: the
 *   key's index, a partial index, a check and the other table's foreign key
 *   are made on the new column before the switch, and a view that reads the
 *   column is made again at the switch with its grant; the old column is
 *   then dropped with nothing left using it.
 * - A rename of a uniquely indexed `email` to `login`: the unique
 *   constraint and an index take the new column's names, readers on the old
 *   name keep their index until the contract.
 * - What the Op does not carry (a materialized view, a view the build does
 *   not declare) is refused at the Plan, naming it.
 *
 * Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeApply } from "@intentius/chant/apply";
import type { OpRunResult } from "@intentius/chant/op";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { ApprovingLedger, runMigrationOp, runOutcome } from "../testing/migration";
import type { PostgresClient } from "../live/client";
import { planPgAgainstServer } from "../plan/commands";
import { postgresApply } from "../../op/activities/postgres-apply";
import { toApplyResult } from "../../op/activities";
import { postgresMigrationPlan, type PostgresMigrationDeps } from "../../op/activities/postgres-migration";
import type { PostgresMigrationOpConfig } from "./op";

const enabled = await dockerAvailable();
let server: TestPostgres | undefined;
let admin: PostgresClient | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-pg-carry-"));

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
const all = async <T>(sql: string): Promise<T[]> => admin!.query<T>(sql);
const columnsOf = async (table: string) =>
  (await all<{ name: string }>(`SELECT attname AS name FROM pg_catalog.pg_attribute WHERE attrelid = '${table}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)).map((r) => r.name);
const constraintsOf = async (table: string) =>
  all<{ name: string; def: string; validated: boolean }>(
    `SELECT conname AS name, pg_catalog.pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_catalog.pg_constraint WHERE conrelid = '${table}'::regclass AND contype <> 'n' ORDER BY conname`,
  );
const indexesOf = async (table: string) =>
  all<{ name: string; def: string }>(`SELECT c.relname AS name, pg_catalog.pg_get_indexdef(c.oid) AS def FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = '${table}'::regclass ORDER BY 1`);
const outcome = runOutcome;
const runOp = (config: PostgresMigrationOpConfig, ledger: ApprovingLedger): Promise<OpRunResult> => runMigrationOp(config, ledger.port, deps);

const schemaObj = (name: string): Obj => ({ export: name, type: "Postgres::Schema", ddl: `CREATE SCHEMA ${name}` });

describe.skipIf(!enabled)("integer to bigint on a primary key another table references", () => {
  const ACCT = schemaObj("acct");
  const accounts = (id: string): Obj => ({
    export: "accounts",
    type: "Postgres::Table",
    dependsOn: ["acct"],
    ddl: `CREATE TABLE acct.accounts (
  id ${id} CONSTRAINT accounts_pkey PRIMARY KEY,
  name text NOT NULL,
  CONSTRAINT accounts_id_check CHECK (id > 0)
);
COMMENT ON CONSTRAINT accounts_pkey ON acct.accounts IS 'One per account'`,
  });
  const ENTRIES: Obj = {
    export: "entries",
    type: "Postgres::Table",
    dependsOn: ["acct", "accounts"],
    ddl: "CREATE TABLE acct.entries (id integer PRIMARY KEY, account_id integer NOT NULL REFERENCES acct.accounts (id) ON DELETE CASCADE, amount numeric NOT NULL)",
  };
  const BY_NAME: Obj = { export: "accountsByName", type: "Postgres::Index", dependsOn: ["accounts"], ddl: "CREATE INDEX accounts_name_id_idx ON acct.accounts (name, id) WHERE id > 100" };
  const BALANCES: Obj = {
    export: "balances",
    type: "Postgres::View",
    dependsOn: ["accounts", "entries"],
    ddl: "CREATE VIEW acct.balances AS SELECT a.id, a.name, sum(e.amount) AS balance FROM acct.accounts a JOIN acct.entries e ON e.account_id = a.id GROUP BY a.id, a.name",
  };
  const V1 = [ACCT, accounts("integer"), ENTRIES, BY_NAME, BALANCES];
  const V2 = [ACCT, accounts("bigint"), ENTRIES, BY_NAME, BALANCES];
  const config = (): PostgresMigrationOpConfig => ({
    name: "migrate-accounts-id",
    env: "e2e",
    table: "acct.accounts",
    column: "id",
    build: false,
    path: dir,
    output: "accounts-v2.json",
    retain: "0s",
    batchSize: 400,
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
  });
  const ledger = new ApprovingLedger();

  test("carried over, switched and contracted: the key, the index, the check, the other table's foreign key and the view are on the bigint column", async () => {
    expect(normalizeApply(toApplyResult(await apply(writeBuild("accounts-v1.json", V1)))).notAttempted).toEqual([]);
    await admin!.query("INSERT INTO acct.accounts SELECT g, 'a' || g FROM generate_series(1, 1000) g");
    await admin!.query("INSERT INTO acct.entries SELECT g, (g % 1000) + 1, g FROM generate_series(1, 3000) g");
    await admin!.query("CREATE ROLE reporter");
    await admin!.query("GRANT SELECT ON acct.balances TO reporter");
    writeBuild("accounts-v2.json", V2);
    expect((await plan("accounts-v2.json")).changes.map((c) => [c.rule, c.field])).toEqual([["SQLPG207", "columns.id.type"]]);

    const first = await runOp(config(), ledger);
    expect(first.status).toBe("gated");
    expect(outcome(first, "Change")).toBe("type");
    expect(outcome(first, "CarriedBuilt")).toBe(4);
    expect(String(outcome(first, "Verification"))).toMatch(/1000 row\(s\).*check accounts_id_check, key accounts_pkey, foreign-key entries_account_id_fkey, index accounts_name_id_idx carried over, view\(s\) acct\.balances made again at the switch/);
    // The working copies are there, valid, and out of every plan.
    expect((await indexesOf("acct.accounts")).map((i) => i.def)).toEqual([
      "CREATE INDEX accounts_name_id_idx ON acct.accounts USING btree (name, id) WHERE (id > 100)",
      "CREATE INDEX accounts_name_id_idx__chant_new ON acct.accounts USING btree (name, id__chant_new) WHERE (id__chant_new > 100)",
      "CREATE UNIQUE INDEX accounts_pkey ON acct.accounts USING btree (id)",
      "CREATE UNIQUE INDEX accounts_pkey__chant_new ON acct.accounts USING btree (id__chant_new)",
    ]);
    expect(await constraintsOf("acct.entries")).toEqual([
      { name: "entries_account_id_fkey", def: "FOREIGN KEY (account_id) REFERENCES acct.accounts(id) ON DELETE CASCADE", validated: true },
      { name: "entries_account_id_fkey__chant_new", def: "FOREIGN KEY (account_id) REFERENCES acct.accounts(id__chant_new) ON DELETE CASCADE", validated: true },
      { name: "entries_pkey", def: "PRIMARY KEY (id)", validated: true },
    ]);
    expect((await plan("accounts-v2.json")).changes.map((c) => c.rule)).toEqual(["SQLPG207"]);
    // Writes during the migration: both keys hold, and a cascade goes through both foreign keys.
    await admin!.query("INSERT INTO acct.accounts (id, name) VALUES (5000, 'late')");
    await admin!.query("INSERT INTO acct.entries VALUES (9000, 5000, 1)");
    await expect(admin!.query("INSERT INTO acct.entries VALUES (9001, 7777, 1)")).rejects.toThrow(/violates foreign key constraint/);
    await admin!.query("DELETE FROM acct.accounts WHERE id = 1000");
    expect(await one("SELECT count(*)::int AS n FROM acct.entries WHERE account_id = 1000")).toEqual({ n: 0 });

    // A second run carries nothing again.
    const again = await runOp(config(), ledger);
    expect(again.status).toBe("gated");
    expect(outcome(again, "CarriedBuilt")).toBe(0);
    expect(again.gate!.planDigest).toBe(first.gate!.planDigest);

    ledger.approveLast();
    const switched = await runOp(config(), ledger);
    expect(switched.status).toBe("gated");
    expect(switched.gate).toMatchObject({ gate: "approve-migrate-accounts-id-contract" });
    expect(await one("SELECT pg_catalog.format_type(atttypid, atttypmod) AS t FROM pg_catalog.pg_attribute WHERE attrelid = 'acct.accounts'::regclass AND attname = 'id'")).toEqual({ t: "bigint" });
    expect(await constraintsOf("acct.accounts")).toEqual([
      { name: "accounts_id_check", def: "CHECK ((id > 0))", validated: true },
      { name: "accounts_pkey", def: "PRIMARY KEY (id)", validated: true },
    ]);
    expect(await one("SELECT pg_catalog.obj_description(oid, 'pg_constraint') AS c FROM pg_catalog.pg_constraint WHERE conname = 'accounts_pkey'")).toEqual({ c: "One per account" });
    expect(await constraintsOf("acct.entries")).toEqual([
      { name: "entries_account_id_fkey", def: "FOREIGN KEY (account_id) REFERENCES acct.accounts(id) ON DELETE CASCADE", validated: true },
      { name: "entries_pkey", def: "PRIMARY KEY (id)", validated: true },
    ]);
    expect((await indexesOf("acct.accounts")).map((i) => i.def)).toEqual([
      "CREATE INDEX accounts_name_id_idx ON acct.accounts USING btree (name, id) WHERE (id > 100)",
      "CREATE UNIQUE INDEX accounts_pkey ON acct.accounts USING btree (id)",
    ]);
    // The view reads the bigint column, and the reporter can still read it.
    expect(await one("SELECT pg_catalog.format_type(atttypid, atttypmod) AS t FROM pg_catalog.pg_attribute WHERE attrelid = 'acct.balances'::regclass AND attname = 'id'")).toEqual({ t: "bigint" });
    expect(await one("SELECT pg_catalog.has_table_privilege('reporter', 'acct.balances', 'SELECT') AS ok")).toEqual({ ok: true });
    expect(await one("SELECT balance::int AS b FROM acct.balances WHERE id = 5000")).toEqual({ b: 1 });
    expect((await plan("accounts-v2.json")).changes).toEqual([]);
    // The keys hold on the new column: past integer's range, and against a missing account.
    await admin!.query("INSERT INTO acct.accounts (id, name) VALUES (3000000000, 'big')");
    await admin!.query("INSERT INTO acct.entries VALUES (9002, 5000, 2)");
    await expect(admin!.query("INSERT INTO acct.entries VALUES (9003, 7777, 1)")).rejects.toThrow(/violates foreign key constraint "entries_account_id_fkey"/);
    await expect(admin!.query("INSERT INTO acct.accounts (id, name) VALUES (5000, 'again')")).rejects.toThrow(/violates unique constraint "accounts_pkey"/);

    ledger.approveLast();
    const contracted = await runOp(config(), ledger);
    expect(contracted.status).toBe("ok");
    expect(await columnsOf("acct.accounts")).toEqual(["name", "id"]);
    expect((await plan("accounts-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("a rename of a uniquely indexed email", () => {
  const PEOPLE_SCHEMA = schemaObj("crm");
  const people = (column: string, hint = ""): Obj => ({
    export: "people",
    type: "Postgres::Table",
    dependsOn: ["crm"],
    ddl: `CREATE TABLE crm.people (
  id bigint PRIMARY KEY,
  ${column} text NOT NULL UNIQUE,${hint}
  name text
)`,
  });
  const byName = (column: string): Obj => ({ export: "peopleByName", type: "Postgres::Index", dependsOn: ["people"], ddl: `CREATE INDEX people_${column}_name_idx ON crm.people (${column}, name)` });
  const V1 = [PEOPLE_SCHEMA, people("email"), byName("email")];
  const V2 = [PEOPLE_SCHEMA, people("login", " -- previously: email"), byName("login")];
  const config = (): PostgresMigrationOpConfig => ({
    name: "migrate-people-login",
    env: "e2e",
    table: "crm.people",
    column: "login",
    build: false,
    path: dir,
    output: "people-v2.json",
    retain: "0s",
    stack: MARKER.stack,
    ownershipEnv: MARKER.env,
  });
  const ledger = new ApprovingLedger();

  test("the unique constraint and the index move to login under login's names; old readers keep theirs until the contract", async () => {
    await apply(writeBuild("people-v1.json", V1));
    await admin!.query("INSERT INTO crm.people SELECT g, 'p' || g || '@example.com', 'n' || g FROM generate_series(1, 1500) g");
    writeBuild("people-v2.json", V2);

    const first = await runOp(config(), ledger);
    expect(first.status).toBe("gated");
    expect(outcome(first, "Change")).toBe("rename");
    expect(String(outcome(first, "Verification"))).toMatch(/key people_email_key \(as people_login_key\), index people_email_name_idx \(as people_login_name_idx\) carried over/);
    // The unique index on login enforces during the migration, whichever name a writer uses.
    await expect(admin!.query("INSERT INTO crm.people (id, email) VALUES (5000, 'p1@example.com')")).rejects.toThrow(/violates unique constraint/);

    ledger.approveLast();
    const switched = await runOp(config(), ledger);
    expect(switched.status).toBe("gated");
    expect(await constraintsOf("crm.people")).toEqual([
      { name: "people_email_key__chant_old", def: "UNIQUE (email)", validated: true },
      { name: "people_login_key", def: "UNIQUE (login)", validated: true },
      { name: "people_pkey", def: "PRIMARY KEY (id)", validated: true },
    ]);
    expect((await indexesOf("crm.people")).map((i) => i.name)).toEqual(["people_email_key__chant_old", "people_email_name_idx__chant_old", "people_login_key", "people_login_name_idx", "people_pkey"]);
    // The plan sees login with its unique constraint and index, as declared; the kept ones on email are left out.
    expect((await plan("people-v2.json")).changes).toEqual([]);
    await expect(admin!.query("INSERT INTO crm.people (id, login) VALUES (5001, 'p2@example.com')")).rejects.toThrow(/violates unique constraint/);
    await admin!.query("INSERT INTO crm.people (id, email) VALUES (5002, 'old@example.com')");
    expect(await one("SELECT login FROM crm.people WHERE id = 5002")).toEqual({ login: "old@example.com" });

    ledger.approveLast();
    expect((await runOp(config(), ledger)).status).toBe("ok");
    expect(await columnsOf("crm.people")).toEqual(["id", "name", "login"]);
    expect((await indexesOf("crm.people")).map((i) => i.name)).toEqual(["people_login_key", "people_login_name_idx", "people_pkey"]);
    expect((await plan("people-v2.json")).changes).toEqual([]);
  }, 300_000);
});

describe.skipIf(!enabled)("what the Op does not carry is refused at the Plan", () => {
  const INV = schemaObj("inv");
  const items = (qty: string): Obj => ({ export: "items", type: "Postgres::Table", dependsOn: ["inv"], ddl: `CREATE TABLE inv.items (id bigint PRIMARY KEY, qty ${qty})` });
  const args = (output: string) => ({ table: "inv.items", column: "qty", buildPath: output, environment: "e2e", stack: MARKER.stack, ownershipEnv: MARKER.env, cwd: dir });

  test("a materialized view, and a view the build does not declare", async () => {
    await apply(writeBuild("items-v1.json", [INV, items("integer")]));
    await admin!.query("CREATE MATERIALIZED VIEW inv.totals AS SELECT sum(qty) AS total FROM inv.items");
    await admin!.query("CREATE VIEW inv.stock AS SELECT id, qty FROM inv.items");
    writeBuild("items-v2.json", [INV, items("bigint")]);
    const refusal = await postgresMigrationPlan(args("items-v2.json"), undefined, deps()).then(
      () => "",
      (e: unknown) => String((e as Error).message),
    );
    expect(refusal).toMatch(/^inv\.items\.qty is used by what the migration Op does not carry over to the new column: /);
    expect(refusal).toContain("view inv.stock reads the column, and the build does not declare it; the switch makes each such view again from its declaration");
    expect(refusal).toContain("materialized view inv.totals reads the column; making it again would scan in the switch's transaction");
  }, 120_000);
});
