import { table } from "@intentius/chant-lexicon-sql/postgres";
import { orders, shopSchema } from "./schema";

// order_ref is text and orders.id is bigint: Postgres refuses the key, and so does tsc.
export const refunds = table<"shop.refunds">`
  CREATE TABLE ${shopSchema}.refunds (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_ref text NOT NULL REFERENCES ${orders} (${orders.columns.id})
  )`;
