/**
 * The migration Op's follow-ups to #3322 that need no server (#3331): a
 * rename combined with a type change (`reverse`), and a rename of a column
 * with a default, a serial or an identity (`defaultAtContract`). The dual
 * write's body, the contract's statements and the refusals; the e2e is
 * `followups.e2e.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { validateActivitySteps, collectActivityContracts, loadActivityContracts, mergeActivityContracts, type ActivityContract, type OpConfig } from "@intentius/chant/op";
import * as contractsModule from "../../op/activity-contracts";
import type { PostgresClient } from "../live/client";
import type { PgChange } from "../plan/diff";
import { PostgresMigrationOp, type PostgresMigrationOpConfig } from "./op";
import { migrationNames } from "./names";
import { dualWriteBody, contractStatements } from "./steps";
import { migrationPlanSubject, refuseUnsupported, type MigrationObservation, type RelationRow, type ServerColumn } from "./observe";

const BASE: PostgresMigrationOpConfig = { name: "migrate-users-login", env: "prod", table: "app.users", column: "login", build: false };
const propsOf = (config: PostgresMigrationOpConfig) => (PostgresMigrationOp(config).op as unknown as { props: OpConfig }).props;

const names = migrationNames("app", "users", "login", "rename", "email");

const observation = (over: Partial<MigrationObservation> = {}): MigrationObservation =>
  ({
    state: "switched",
    names,
    declared: {} as MigrationObservation["declared"],
    column: { name: "login", type: "text" },
    oid: "16384",
    batchKey: "id",
    keyColumns: [{ name: "id", type: "bigint" }],
    carried: [],
    carriedStates: new Map(),
    views: [],
    partitioned: false,
    columns: new Map(),
    changes: [],
    expression: '"email"',
    publications: [],
    major: 18,
    old: { attnum: 2, name: "email", type: "text", notNull: true, generated: false, identity: false },
    trigger: { name: names.trigger },
    fn: { name: names.fn },
    ...over,
  }) as MigrationObservation;

describe("a rename with a type change", () => {
  const retyped = migrationNames("app", "users", "age", "rename", "age_text");
  const o = { names: retyped, expression: "CAST(age_text AS integer)", reverse: "CAST(age AS text)" };

  test("a writer of the old name has the expression applied, a writer of the new name the reverse", () => {
    const body = dualWriteBody(o);
    expect(body).toContain("IF NEW.age IS NULL THEN NEW.age := (SELECT CAST(age_text AS integer) FROM (SELECT NEW.*) AS users); ELSE NEW.age_text := (SELECT CAST(age AS text) FROM (SELECT NEW.*) AS users); END IF;");
    expect(body).toContain("ELSIF NEW.age IS NOT DISTINCT FROM OLD.age THEN\n    NEW.age := (SELECT CAST(age_text AS integer) FROM (SELECT NEW.*) AS users);");
    expect(body).toContain(
      "ELSIF NEW.age IS DISTINCT FROM (SELECT CAST(age_text AS integer) FROM (SELECT NEW.*) AS users) THEN\n    NEW.age_text := (SELECT CAST(age AS text) FROM (SELECT NEW.*) AS users);\n  END IF;",
    );
  });

  test("an update that sets the new column to what the expression gives (the backfill) leaves the old column alone", () => {
    // Were the old column rewritten from reverse here, a lossy pair ('007' -> 7 -> '7') would change rows nobody wrote, and hide itself from the verification.
    const body = dualWriteBody(o);
    expect(body).not.toMatch(/ELSIF NEW\.age IS DISTINCT FROM OLD\.age THEN/);
    expect(body.match(/NEW\.age_text :=/g)).toHaveLength(2);
  });

  test("a plain rename's body is unchanged", () => {
    expect(dualWriteBody({ names, expression: '"email"' })).toContain("IF NEW.login IS NULL THEN NEW.login := NEW.email; ELSE NEW.email := NEW.login; END IF;");
  });

  test("the reverse is part of what the gate binds", () => {
    const subject = (reverse?: string) =>
      migrationPlanSubject(observation({ state: "migrate", source: { attnum: 2, name: "age_text", type: "text", notNull: false, generated: false, identity: false }, ...(reverse ? { reverse } : {}) }));
    expect(subject("CAST(age AS text)")).toMatchObject({ reverse: "CAST(age AS text)" });
    expect(subject()).not.toHaveProperty("reverse");
  });
});

describe("the contract of a rename that kept its default", () => {
  const sequence = { kind: "serial", schema: "app", name: "users_seq_seq", ident: "app.users_seq_seq" } as const;

  test("a plain default is set on the new column in the contract's transaction, after the old column goes", () => {
    const o = observation({ column: { name: "login", type: "text", default: "'none'" } });
    expect(contractStatements(o)).toEqual([
      "DROP TRIGGER login__chant_sync ON app.users",
      "DROP FUNCTION app.users__login__chant_sync()",
      "ALTER TABLE app.users DROP COLUMN email",
      "ALTER TABLE app.users ALTER COLUMN login SET DEFAULT 'none'",
    ]);
  });

  test("a serial's sequence is handed to the new column before the old one is dropped, and stays its default", () => {
    const o = observation({
      column: { name: "login", type: "serial" },
      old: { attnum: 2, name: "email", type: "integer", notNull: true, default: "nextval('app.users_seq_seq'::regclass)", generated: false, identity: false },
      sequence,
    });
    expect(contractStatements(o)).toEqual([
      "DROP TRIGGER login__chant_sync ON app.users",
      "DROP FUNCTION app.users__login__chant_sync()",
      "ALTER SEQUENCE app.users_seq_seq OWNED BY app.users.login",
      "ALTER TABLE app.users DROP COLUMN email",
      "ALTER TABLE app.users ALTER COLUMN login SET DEFAULT nextval('app.users_seq_seq'::regclass)",
    ]);
  });

  test("an identity moves to the new column under its sequence's name and carries on where the old one stood", () => {
    const o = observation({
      column: { name: "login", type: "integer", generated: { kind: "identity", always: true, options: "(CACHE 5)" } },
      old: { attnum: 2, name: "email", type: "integer", notNull: true, generated: false, identity: true },
      sequence: { ...sequence, kind: "identity" },
    });
    expect(contractStatements(o, { lastValue: "41", isCalled: true })).toEqual([
      "DROP TRIGGER login__chant_sync ON app.users",
      "DROP FUNCTION app.users__login__chant_sync()",
      "ALTER TABLE app.users ALTER COLUMN email DROP IDENTITY",
      "ALTER TABLE app.users DROP COLUMN email",
      "ALTER TABLE app.users ALTER COLUMN login ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME app.users_seq_seq CACHE 5)",
      "SELECT pg_catalog.setval('app.users_seq_seq', 41, true)",
    ]);
    expect(() => contractStatements(o)).toThrow(/needs its sequence's state/);
  });

  test("a rename without a default drops the old column and nothing else, as before", () => {
    expect(contractStatements(observation())).toEqual([
      "DROP TRIGGER login__chant_sync ON app.users",
      "DROP FUNCTION app.users__login__chant_sync()",
      "ALTER TABLE app.users DROP COLUMN email",
    ]);
  });

  test("a type change's contract is the plain drop: its trigger went at the switch", () => {
    const t = migrationNames("app", "orders", "amount", "type", "amount");
    const o = observation({
      names: t,
      old: { attnum: 3, name: t.oldColumn, type: "text", notNull: false, generated: false, identity: false },
      column: { name: "amount", type: "numeric", default: "0" },
    });
    delete (o as { trigger?: unknown }).trigger;
    delete (o as { fn?: unknown }).fn;
    expect(contractStatements(o)).toEqual(["ALTER TABLE app.orders DROP COLUMN amount__chant_old"]);
  });
});

describe("what the Op still refuses", () => {
  const rel: RelationRow = { oid: "16384", kind: "r", partition: false, parents: null, children: null, partkey: null, partattrs: null };
  const source = (over: Partial<ServerColumn> = {}): ServerColumn => ({ attnum: 2, name: "email", type: "text", notNull: false, generated: false, identity: false, ...over });
  const rename = { rule: "SQLPG205", object: "app.users", field: "columns.login", before: "email", after: "login" } as PgChange;
  const retype = { rule: "SQLPG208", object: "app.users", field: "columns.login.type", before: "text", after: "integer" } as PgChange;
  // Every query answers nothing, except the primary key's.
  const client = { query: async (sql: string) => (sql.includes("contype = 'p'") ? [{ name: "id", type: "bigint" }] : []) } as unknown as PostgresClient;
  const run = (extra: { reverse?: string; defaultAtContract?: boolean }, src: ServerColumn, column: { name: string; type: string; default?: string }, changes: PgChange[], isRename = true) =>
    refuseUnsupported(
      { client, target: { defaultSchema: "app" }, declared: { props: {}, canonical: { schema: "app", name: "users" } }, column: "login", ...extra } as never,
      names,
      rel,
      src,
      column as never,
      changes,
      isRename,
      changes.find((c) => c.rule !== "SQLPG205"),
    );

  test("a rename with a type change names reverse, and goes on with it", async () => {
    await expect(run({}, source(), { name: "login", type: "integer" }, [rename, retype])).rejects.toThrow(/give that expression as reverse/);
    await expect(run({ reverse: "CAST(login AS text)" }, source(), { name: "login", type: "integer" }, [rename, retype])).resolves.toMatchObject({ batchKey: "id" });
  });

  test("reverse is refused where nothing needs it, and may not carry the function's quote", async () => {
    await expect(run({ reverse: "x" }, source(), { name: "login", type: "text" }, [rename])).rejects.toThrow(/reverse is for a rename combined with a type change, and this migration is a rename only/);
    await expect(run({ reverse: "x" }, source(), { name: "login", type: "integer" }, [retype], false)).rejects.toThrow(/a type change without a rename/);
    await expect(run({ reverse: "$chant$" }, source(), { name: "login", type: "integer" }, [rename, retype])).rejects.toThrow(/may not contain \$chant\$/);
  });

  test("a rename with a type change and a default or identity is refused whatever is set", async () => {
    const msg = /also changes its type[\s\S]*Rename first/;
    await expect(run({ reverse: "x", defaultAtContract: true }, source({ default: "'a'::text" }), { name: "login", type: "integer" }, [rename, retype])).rejects.toThrow(msg);
    await expect(run({ reverse: "x", defaultAtContract: true }, source({ identity: true }), { name: "login", type: "integer" }, [rename, retype])).rejects.toThrow(msg);
  });

  test("a rename of a column with a default needs defaultAtContract, and says what it gives up", async () => {
    const withDefault = source({ default: "'none'::text" });
    const refused = run({}, withDefault, { name: "login", type: "text", default: "'none'" }, [rename]);
    await expect(refused).rejects.toThrow(/Set defaultAtContract: true/);
    await expect(run({}, withDefault, { name: "login", type: "text", default: "'none'" }, [rename])).rejects.toThrow(/explicit NULL gets the default, and UPDATE \.\.\. SET <new> = DEFAULT sets NULL/);
    await expect(run({}, source({ identity: true }), { name: "login", type: "integer" }, [rename])).rejects.toThrow(/Set defaultAtContract: true/);
    await expect(run({ defaultAtContract: true }, withDefault, { name: "login", type: "text", default: "'none'" }, [rename])).resolves.toMatchObject({ batchKey: "id" });
  });

  test("defaultAtContract is refused on a rename that has no default to wait for", async () => {
    await expect(run({ defaultAtContract: true }, source(), { name: "login", type: "text" }, [rename])).rejects.toThrow(/defaultAtContract is for a rename of a column with a default/);
  });
});

describe("the Op's configuration", () => {
  test("reverse and defaultAtContract reach every step, and the steps still pass the activity contracts", async () => {
    const config: PostgresMigrationOpConfig = { ...BASE, using: "CAST(age_text AS integer)", reverse: "CAST(age AS text)", defaultAtContract: true };
    const props = propsOf(config);
    const steps = props.phases.flatMap((p) => p.steps).filter((s) => s.kind === "activity" && (s as { fn: string }).fn.startsWith("postgresMigration")) as Array<{ args: Record<string, unknown> }>;
    expect(steps).toHaveLength(9);
    for (const s of steps) expect(s.args).toMatchObject({ reverse: "CAST(age AS text)", defaultAtContract: true });
    const contracts = new Map<string, ActivityContract>();
    collectActivityContracts(contractsModule as unknown as Record<string, unknown>, contracts);
    expect(validateActivitySteps(props, mergeActivityContracts(await loadActivityContracts([]), contracts))).toEqual([]);
    for (const s of propsOf(BASE).phases.flatMap((p) => p.steps)) if (s.kind === "activity") expect((s as { args?: Record<string, unknown> }).args ?? {}).not.toHaveProperty("defaultAtContract");
  });
});
