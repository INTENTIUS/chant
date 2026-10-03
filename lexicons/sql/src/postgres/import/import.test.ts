import { describe, expect, test } from "vitest";
import { exportNames, objectsToIR, type ImportedPgObject } from "./ir";
import { PostgresGenerator } from "./generator";
import { sqlTemplateGenerator } from "../../import-generator";

/** What Postgres 18.6 prints for the getting-started example (`../live/catalog.ts`). */
const PRINTED: ImportedPgObject[] = [
  { type: "Postgres::Schema", name: "app", ddl: "CREATE SCHEMA app;\nCOMMENT ON SCHEMA app IS 'The shop'" },
  { type: "Postgres::Enum", schema: "app", name: "order_status", ddl: "CREATE TYPE app.order_status AS ENUM ('placed', 'paid')" },
  { type: "Postgres::Sequence", schema: "app", name: "invoice_seq", ddl: "CREATE SEQUENCE app.invoice_seq START WITH 1000" },
  {
    type: "Postgres::Table",
    schema: "app",
    name: "orders",
    ddl: `CREATE TABLE app.orders (
    id bigint GENERATED ALWAYS AS IDENTITY,
    user_id bigint NOT NULL,
    invoice_no bigint DEFAULT nextval('app.invoice_seq'::regclass) NOT NULL,
    status app.order_status DEFAULT 'placed'::app.order_status NOT NULL,
    CONSTRAINT orders_pkey PRIMARY KEY (id),
    CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE
);
COMMENT ON TABLE app.orders IS 'Placed'`,
  },
  {
    type: "Postgres::Table",
    schema: "app",
    name: "users",
    ddl: "CREATE TABLE app.users (\n    id bigint GENERATED ALWAYS AS IDENTITY,\n    CONSTRAINT users_pkey PRIMARY KEY (id)\n);\nCOMMENT ON COLUMN app.users.id IS 'The key'",
  },
  { type: "Postgres::Index", schema: "app", name: "orders_user_id_idx", ddl: "CREATE INDEX orders_user_id_idx ON app.orders USING btree (user_id)" },
  { type: "Postgres::View", schema: "app", name: "order_totals", ddl: "CREATE VIEW app.order_totals AS\nSELECT u.id,\n    count(o.id) AS n\n   FROM app.users u\n     LEFT JOIN app.orders o ON o.user_id = u.id\n  GROUP BY u.id" },
  { type: "Postgres::Extension", name: "citext", ddl: "CREATE EXTENSION citext WITH SCHEMA app" },
];

describe("importing a Postgres server", () => {
  const content = new PostgresGenerator().generate(objectsToIR(PRINTED))[0]!.content;

  test("export names are camel case, a schema's and an extension's marked as such", () => {
    expect(exportNames(PRINTED)).toEqual(["appSchema", "orderStatus", "invoiceSeq", "orders", "users", "ordersUserIdIdx", "orderTotals", "citextExtension"]);
  });

  test("references to imported objects are interpolated, and the file is in dependency order", () => {
    expect(content).toContain('import { extension, index, schema, sequence, table, type, view } from "@intentius/chant-lexicon-sql/postgres";');
    expect(content).toContain("CREATE TABLE ${appSchema}.orders (");
    expect(content).toContain("DEFAULT nextval(${invoiceSeq}) NOT NULL");
    expect(content).toContain("status ${orderStatus} DEFAULT 'placed'::${orderStatus} NOT NULL");
    expect(content).toContain("REFERENCES ${users}(id) ON DELETE CASCADE");
    expect(content).toContain("COMMENT ON TABLE ${appSchema}.orders IS 'Placed'");
    expect(content).toContain("COMMENT ON COLUMN ${appSchema}.users.id IS 'The key'");
    expect(content).toContain("CREATE INDEX orders_user_id_idx ON ${orders} USING btree (user_id)");
    expect(content).toContain("FROM ${users} u");
    expect(content).toContain("CREATE EXTENSION citext WITH SCHEMA ${appSchema}");
    const at = (n: string) => content.indexOf(`export const ${n} `);
    expect(at("users")).toBeLessThan(at("orders"));
    expect(at("invoiceSeq")).toBeLessThan(at("orders"));
    expect(at("orders")).toBeLessThan(at("ordersUserIdIdx"));
    expect(at("appSchema")).toBeLessThan(at("citextExtension"));
  });

  test("the sql generator sends a Postgres IR to the Postgres generator", () => {
    expect(sqlTemplateGenerator.generate(objectsToIR(PRINTED))[0]!.content).toBe(content);
  });

  test("a backquote and ${ in the DDL are escaped for the template", () => {
    const out = new PostgresGenerator().generate(
      objectsToIR([{ type: "Postgres::Table", schema: "app", name: "t", ddl: "CREATE TABLE app.t (\n    a text DEFAULT '${x} `y`'::text\n)" }]),
    )[0]!.content;
    expect(out).toContain("DEFAULT '\\${x} \\`y\\`'::text");
  });
});
