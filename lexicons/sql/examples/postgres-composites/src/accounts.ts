import { SoftDeleteTable } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";

// created_at, updated_at and deleted_at are added; `users_live` reads the rows
// not deleted, and `users_live_idx` covers them by email.
export const users = SoftDeleteTable({
  name: "users",
  schema: app,
  columns: `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    display_name text NOT NULL`,
  liveKey: "email",
  comment: "One row per account; email is personal data, unique among live rows",
});

export const teams = SoftDeleteTable({
  name: "teams",
  schema: app,
  columns: "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL",
});
