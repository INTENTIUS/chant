import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shop = schema`CREATE SCHEMA shop`;

// The source tables of the ClickHouse CDC mirror in ../cdc-mirror. A build
// holds one dialect, so the two sides are two projects: this one declares
// what the application writes, that one what the pipeline fills. `chant
// migrate --from sql/postgres --to sql/clickhouse` writes the mirror from
// this file, and in a workspace links each mirrored column to the output
// named here, so dropping or renaming one fails `chant workspace check`.
export const customers = table`
  CREATE TABLE ${shop}.customers (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email      text NOT NULL,
    country    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  COMMENT ON COLUMN ${shop}.customers.email IS 'PII, hashed downstream'`;

export const orders = table`
  CREATE TABLE ${shop}.orders (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES ${customers} (${customers.columns.id}),
    total       numeric(12, 2) NOT NULL,
    status      text NOT NULL,
    placed_at   timestamptz NOT NULL DEFAULT now()
  )`;

export const ordersByCustomer = index`
  CREATE INDEX orders_by_customer_idx ON ${orders} (${orders.columns.customer_id}, ${orders.columns.placed_at} DESC)`;
