import { describe, expect, test } from "vitest";
import { database, table as chTable, view as chView } from "./clickhouse/entities";
import { schema, table, view } from "./postgres/entities";
import { sqlWorkspaceOutputs } from "./workspace-outputs";

const names = (entities: Record<string, unknown>) => sqlWorkspaceOutputs(new Map(Object.entries(entities)) as never)?.outputs.map((o) => o.name);

describe("sqlWorkspaceOutputs: Postgres (#3931)", () => {
  test("an unqualified table is in public, and an unquoted name folds to lower case", () => {
    expect(names({ orders: table`CREATE TABLE Orders (Customer_ID bigint, amount numeric)` })).toEqual([
      "public.orders",
      "public.orders.amount",
      "public.orders.customer_id",
    ]);
  });

  test("a quoted name keeps its case and is a different output", () => {
    expect(names({ orders: table`CREATE TABLE "Orders" ("CustomerId" bigint)` })).toEqual(["public.Orders", "public.Orders.CustomerId"]);
  });

  test("a declared schema qualifies the name", () => {
    const app = schema`CREATE SCHEMA app`;
    expect(names({ app, users: table`CREATE TABLE ${app}.users (id bigint)` })).toEqual(["app.users", "app.users.id"]);
  });

  test("a view's columns come from its select list; a * is a gap", () => {
    const orders = table`CREATE TABLE orders (id bigint, customer_id bigint, amount numeric)`;
    const totals = view`CREATE VIEW totals AS SELECT customer_id, sum(amount) AS total FROM ${orders} GROUP BY customer_id`;
    expect(names({ orders, totals })).toContain("public.totals.total");
    expect(names({ orders, totals })).toContain("public.totals.customer_id");

    const all = view`CREATE MATERIALIZED VIEW everything AS SELECT * FROM ${orders}`;
    const report = sqlWorkspaceOutputs(new Map<string, unknown>([["orders", orders], ["all", all]]) as never)!;
    expect(report.outputs.map((o) => o.name)).toContain("public.everything");
    expect(report.gaps?.join("\n")).toContain("view public.everything (all)");
  });

  test("a renamed column reports its old name", () => {
    const report = sqlWorkspaceOutputs(new Map([["orders", table`CREATE TABLE orders (
      buyer_id bigint -- previously: customer_id
    )`]]) as never)!;
    expect(report.outputs.find((o) => o.name === "public.orders.buyer_id")?.previously).toEqual(["public.orders.customer_id"]);
  });

  test("a file importing the lexicon that did not fold is a gap; other files are not", () => {
    const report = sqlWorkspaceOutputs(new Map(), [
      { file: "db/src/a.ts", text: `import { table } from "@intentius/chant-lexicon-sql/postgres";`, reason: "it reads process.env" },
      { file: "db/src/b.ts", text: `export const x = 1;`, reason: "it does not fold" },
    ])!;
    expect(report.outputs).toEqual([]);
    expect(report.gaps).toEqual(["db/src/a.ts imports the sql lexicon and does not fold, so the tables it declares were not read: it reads process.env"]);
    expect(sqlWorkspaceOutputs(new Map(), [{ file: "b.ts", text: "", reason: "x" }])).toBeUndefined();
  });
});

describe("sqlWorkspaceOutputs: ClickHouse (#3931)", () => {
  test("an unqualified table is in default, and names keep their case", () => {
    expect(names({ events: chTable`CREATE TABLE Events (UserId UUID) ENGINE = MergeTree ORDER BY UserId` })).toEqual(["default.Events", "default.Events.UserId"]);
  });

  test("a declared database qualifies the name; an aliased view's columns are read", () => {
    const analytics = database`CREATE DATABASE analytics`;
    const events = chTable`CREATE TABLE ${analytics}.events (ts DateTime, user_id UUID) ENGINE = MergeTree ORDER BY ts`;
    const daily = chView`CREATE VIEW ${analytics}.daily AS SELECT toDate(ts) AS day, count() AS n FROM ${events} GROUP BY day`;
    expect(names({ analytics, events, daily })).toEqual([
      "analytics.daily",
      "analytics.daily.day",
      "analytics.daily.n",
      "analytics.events",
      "analytics.events.ts",
      "analytics.events.user_id",
    ]);
  });

  test("an unaliased expression in a view's select list is a gap", () => {
    const events = chTable`CREATE TABLE events (ts DateTime) ENGINE = MergeTree ORDER BY ts`;
    const mv = chView`CREATE MATERIALIZED VIEW counts ENGINE = MergeTree ORDER BY tuple() AS SELECT count() FROM ${events}`;
    const report = sqlWorkspaceOutputs(new Map<string, unknown>([["events", events], ["mv", mv]]) as never)!;
    expect(report.outputs.map((o) => o.name)).toContain("default.counts");
    expect(report.gaps?.join("\n")).toContain("view default.counts (mv)");
  });
});
