import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema`CREATE SCHEMA app`;

export const accounts = table`
  CREATE TABLE ${app}.accounts (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email      text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  COMMENT ON COLUMN ${app}.accounts.email IS 'Login name'`;

export const sessions = table`
  CREATE TABLE ${app}.sessions (
    id         uuid PRIMARY KEY,
    account_id bigint NOT NULL REFERENCES ${accounts} (id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
  )`;

export const sessionsAccountId = index`CREATE INDEX sessions_account_id ON ${sessions} (account_id)`;
