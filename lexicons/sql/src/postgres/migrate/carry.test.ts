/**
 * Carrying what uses the migrated column over to the new one (#3322), the
 * parts that need no server: the column references rewritten in an index,
 * a check and a foreign key, the names a rename gives, and the switch's
 * statements. `carry.e2e.test.ts` runs them against the pinned server.
 */

import { describe, expect, test } from "vitest";
import { carriedIndexStatement, carriedSwitchStatements, renamedDefault, replaceColumn, replaceInForeignKey, requiresNotNull, type CarriedObject } from "./carry";

describe("column references", () => {
  test("only the column: not a qualifier, a function, a cast's type, an access method or a string", () => {
    expect(replaceColumn("CHECK ((id > 0) AND (lower(name) <> 'id') AND (id::text <> t.id))", "id", "id__chant_new")).toBe(
      "CHECK ((id__chant_new > 0) AND (lower(name) <> 'id') AND (id__chant_new::text <> t.id))",
    );
    expect(replaceColumn("x::text", "text", "y")).toBe("x::text");
    expect(replaceColumn('("Email" = email)', "Email", "login")).toBe("(login = email)");
  });

  test("an index: CONCURRENTLY under its working name, the column replaced in its keys, INCLUDE and WHERE", () => {
    expect(carriedIndexStatement("CREATE INDEX t_a_idx ON d.t USING btree (a, b) INCLUDE (a) WHERE (a > 0)", "t_a_idx__chant_new", "a", "a__chant_new")).toBe(
      "CREATE INDEX CONCURRENTLY t_a_idx__chant_new ON d.t USING btree (a__chant_new, b) INCLUDE (a__chant_new) WHERE (a__chant_new > 0)",
    );
    expect(carriedIndexStatement("CREATE UNIQUE INDEX users_email_key ON app.users USING btree (email) NULLS NOT DISTINCT", "users_email_key__chant_new", "email", "login")).toBe(
      "CREATE UNIQUE INDEX CONCURRENTLY users_email_key__chant_new ON app.users USING btree (login) NULLS NOT DISTINCT",
    );
  });

  test("a foreign key: the referencing side, the referenced side, or both for one onto its own table", () => {
    const def = "FOREIGN KEY (id) REFERENCES app.users(id) ON DELETE SET NULL (id)";
    expect(replaceInForeignKey(def, "id", "n", { local: false, referenced: true })).toBe("FOREIGN KEY (id) REFERENCES app.users(n) ON DELETE SET NULL (id)");
    expect(replaceInForeignKey(def, "id", "n", { local: true, referenced: false })).toBe("FOREIGN KEY (n) REFERENCES app.users(id) ON DELETE SET NULL (n)");
    expect(replaceInForeignKey(def, "id", "n", { local: true, referenced: true })).toBe("FOREIGN KEY (n) REFERENCES app.users(n) ON DELETE SET NULL (n)");
  });
});

describe("names after a rename", () => {
  test("a name Postgres made from the old column becomes the one it makes from the new; any other is kept", () => {
    expect(renamedDefault("users_email_key", "users", ["email"], ["login"], "key")).toBe("users_login_key");
    expect(renamedDefault("users_tenant_email_key", "users", ["tenant", "email"], ["tenant", "login"], "key")).toBe("users_tenant_login_key");
    expect(renamedDefault("unique_email", "users", ["email"], ["login"], "key")).toBeUndefined();
    expect(renamedDefault(`users_email_key`, "users", ["email"], ["l".repeat(60)], "key")).toBeUndefined();
  });
});

const key = (over: Partial<CarriedObject> = {}): CarriedObject => ({
  kind: "key",
  name: "accounts_pkey",
  table: "acct.accounts",
  tableName: "acct.accounts",
  tableOid: "1",
  schema: "acct",
  working: "accounts_pkey__chant_new",
  target: "accounts_pkey",
  definition: "CREATE UNIQUE INDEX CONCURRENTLY accounts_pkey__chant_new ON acct.accounts USING btree (id__chant_new)",
  primary: true,
  validated: true,
  ...over,
});

describe("the switch", () => {
  const old = (c: CarriedObject) => `old ${c.name}`;

  test("foreign keys first, then checks, keys and indexes; a type change drops the old ones", () => {
    const fk: CarriedObject = { ...key(), kind: "foreign-key", name: "entries_account_id_fkey", table: "acct.entries", working: "entries_account_id_fkey__chant_new", target: "entries_account_id_fkey", comment: "Each entry's account" };
    delete fk.primary;
    const idx: CarriedObject = { ...key(), kind: "index", name: "accounts_name_id_idx", working: "accounts_name_id_idx__chant_new", target: "accounts_name_id_idx", clustered: true };
    delete idx.primary;
    const { before, after } = carriedSwitchStatements([idx, key({ comment: "One per account", deferral: " DEFERRABLE" }), fk], [], "type", old, undefined);
    expect(before).toEqual([
      "ALTER TABLE acct.entries DROP CONSTRAINT entries_account_id_fkey",
      "ALTER TABLE acct.entries RENAME CONSTRAINT entries_account_id_fkey__chant_new TO entries_account_id_fkey",
      "COMMENT ON CONSTRAINT entries_account_id_fkey ON acct.entries IS 'Each entry''s account'",
      "ALTER TABLE acct.accounts DROP CONSTRAINT accounts_pkey",
      "ALTER TABLE acct.accounts ADD CONSTRAINT accounts_pkey PRIMARY KEY USING INDEX accounts_pkey__chant_new DEFERRABLE",
      "COMMENT ON CONSTRAINT accounts_pkey ON acct.accounts IS 'One per account'",
      "COMMENT ON INDEX acct.accounts_pkey IS NULL",
      "DROP INDEX acct.accounts_name_id_idx",
      "ALTER INDEX acct.accounts_name_id_idx__chant_new RENAME TO accounts_name_id_idx",
      "COMMENT ON INDEX acct.accounts_name_id_idx IS NULL",
      "ALTER TABLE acct.accounts CLUSTER ON accounts_name_id_idx",
    ]);
    expect(after).toEqual([]);
  });

  test("a rename keeps the old unique constraint and index for readers of the old name, under __chant_old, until the contract", () => {
    const u = key({ primary: false, name: "users_email_key", working: "users_email_key__chant_new", target: "users_login_key", table: "app.users", schema: "app", replicaIdentity: true });
    const { before } = carriedSwitchStatements([u], [], "rename", old, undefined);
    expect(before).toEqual([
      "ALTER TABLE app.users RENAME CONSTRAINT users_email_key TO users_email_key__chant_old",
      "COMMENT ON CONSTRAINT users_email_key__chant_old ON app.users IS 'old users_email_key'",
      "ALTER TABLE app.users ADD CONSTRAINT users_login_key UNIQUE USING INDEX users_email_key__chant_new",
      "COMMENT ON CONSTRAINT users_login_key ON app.users IS NULL",
      "COMMENT ON INDEX app.users_login_key IS NULL",
      "ALTER TABLE app.users REPLICA IDENTITY USING INDEX users_login_key",
    ]);
  });

  test("a primary key makes the new column NOT NULL whatever the column declares", () => {
    expect(requiresNotNull({ name: "id", type: "bigint" }, [key()])).toBe(true);
    expect(requiresNotNull({ name: "id", type: "bigint" }, [key({ primary: false })])).toBe(false);
  });
});
