/**
 * The Postgres deep reader's columns (INTENTIUS/sql-yodeler#47): matched by
 * name, not by position, because Postgres keeps a table's columns in the
 * order they were added and a column renamed by expand and contract is last
 * on the server.
 */

import { describe, expect, test } from "vitest";
import * as pg from "../entities";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";
import type { LivePgObject } from "../live/catalog";
import { inDeclaredVocabulary, liveProps } from "./deep";
import { canonicalPgObject } from "./normalize";

type Props = Record<string, unknown>;

const declared = (pg.table`
  CREATE TABLE shop.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      email text NOT NULL, -- previously: customer_email
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      refunded_at timestamp with time zone,
      CONSTRAINT orders_pkey PRIMARY KEY (id)
  )` as unknown as { props: Props }).props;

/** What the deep reader makes of the server's definition of the table. */
function observe(statement: string): Props {
  const o = { type: POSTGRES_ENTITY_TYPES.table, schema: "shop", name: "orders", oid: "1", statement } as unknown as LivePgObject;
  const live = liveProps(o);
  return inDeclaredVocabulary(declared, live, canonicalPgObject(POSTGRES_ENTITY_TYPES.table, declared), canonicalPgObject(POSTGRES_ENTITY_TYPES.table, live));
}

const names = (p: Props) => (p.columns as Array<{ name: string }>).map((c) => c.name);

describe("Postgres deep observation of a table's columns", () => {
  test("a column the server holds last and the declaration earlier is not drift", () => {
    const props = observe(`CREATE TABLE shop.orders (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    status text DEFAULT 'placed'::text NOT NULL,
    amount numeric(12,2) NOT NULL,
    refunded_at timestamp with time zone,
    email text NOT NULL,
    CONSTRAINT orders_pkey PRIMARY KEY (id)
)`);
    expect(props.columns).toEqual(declared.columns);
  });

  test("a column that differs is reported at its declared place, and an undeclared one comes after the declared ones", () => {
    const props = observe(`CREATE TABLE shop.orders (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    note text,
    status text DEFAULT 'placed'::text NOT NULL,
    amount numeric(12,2) NOT NULL,
    refunded_at timestamp with time zone,
    email character varying(200) NOT NULL,
    CONSTRAINT orders_pkey PRIMARY KEY (id)
)`);
    expect(names(props)).toEqual(["id", "email", "status", "amount", "refunded_at", "note"]);
    const columns = props.columns as Props[];
    const declaredColumns = declared.columns as Props[];
    expect(columns[1]).not.toEqual(declaredColumns[1]);
    expect(columns.slice(2, 5)).toEqual(declaredColumns.slice(2, 5));
  });

  test("a declared column the server does not have leaves the others matched by name", () => {
    const props = observe(`CREATE TABLE shop.orders (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    status text DEFAULT 'placed'::text NOT NULL,
    amount numeric(12,2) NOT NULL,
    email text NOT NULL,
    CONSTRAINT orders_pkey PRIMARY KEY (id)
)`);
    expect(names(props)).toEqual(["id", "email", "status", "amount"]);
  });
});
