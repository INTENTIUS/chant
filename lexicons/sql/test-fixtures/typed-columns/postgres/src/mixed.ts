import { table, view } from "@intentius/chant-lexicon-sql/postgres";
import { legacy, orders, shopSchema } from "./schema";

// A typed table's key to an untyped table's column compiles: adoption goes one declaration at a time.
export const notes = table<"shop.notes">`
  CREATE TABLE ${shopSchema}.notes (
    legacy_id int REFERENCES ${legacy} (${legacy.columns.id}),
    body text
  )`;

// A view's column that passes one column through has that column's type.
export const recent = view<"shop.recent">`
  CREATE VIEW ${shopSchema}.recent AS
  SELECT o.${orders.columns.id}, o.${orders.columns.amount} AS total, count(*) AS n
  FROM ${orders} o GROUP BY 1, 2`;
