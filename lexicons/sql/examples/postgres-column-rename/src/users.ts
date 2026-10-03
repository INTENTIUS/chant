import { schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema`CREATE SCHEMA app`;

// The declaration says `login`; the live table still says `username`. That is
// a rename, which ALTER can do in one step but which breaks every reader and
// writer that still uses the old name. rename-username.op.ts carries it out
// as expand and contract instead.
export const users = table`
  CREATE TABLE ${app}.users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    login      text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
