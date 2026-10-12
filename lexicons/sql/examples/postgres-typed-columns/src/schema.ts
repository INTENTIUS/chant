import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shop = schema`CREATE SCHEMA shop`;

// The type argument is the object's qualified name. `chant sql types` writes
// that name's columns into sql-types.d.ts, and tsc checks against them.
export const customers = table<"shop.customers">`
  CREATE TABLE ${shop}.customers (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL UNIQUE
  );
  COMMENT ON COLUMN ${shop}.customers.email IS 'Login name; unique, lower-cased by the app'`;

export const orders = table<"shop.orders">`
  CREATE TABLE ${shop}.orders (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES ${customers} (${customers.columns.id}),
    amount      numeric(12, 2) NOT NULL,
    placed_at   timestamptz NOT NULL DEFAULT now(),
    refunded_at timestamptz
  )`;

export const ordersCustomerId = index`
  CREATE INDEX orders_customer_id_idx ON ${orders} (${orders.columns.customer_id})`;
