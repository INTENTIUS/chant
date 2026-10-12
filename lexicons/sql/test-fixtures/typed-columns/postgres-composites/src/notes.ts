import { table } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";
import { users } from "./accounts";

// A composite member's column, interpolated into another table's foreign key.
export const notes = table<"app.notes">`
  CREATE TABLE ${app}.notes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    author bigint NOT NULL REFERENCES ${users.table} (${users.table.columns.id})
  )`;
