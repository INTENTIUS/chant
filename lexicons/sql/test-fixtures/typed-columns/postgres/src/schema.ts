import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shopSchema = schema`CREATE SCHEMA shop`;

export const customers = table<"shop.customers">`
  CREATE TABLE ${shopSchema}.customers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL
  )`;

export const orders = table<"shop.orders">`
  CREATE TABLE ${shopSchema}.orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES ${customers} (${customers.columns.id}),
    email text NOT NULL,
    amount numeric(12,2) NOT NULL,
    placed_at timestamp with time zone DEFAULT now() NOT NULL,
    refunded_at timestamp with time zone,
    gift boolean DEFAULT false NOT NULL
  )`;

// Index columns are the table's typed columns.
export const ordersPlacedAt = index`CREATE INDEX orders_placed_at_idx ON ${orders} (${orders.columns.placed_at})`;

// No type argument: the columns stay unchecked.
export const legacy = table`CREATE TABLE ${shopSchema}.legacy (id int)`;
export const legacyId = legacy.columns.id;
