import { domain, extension, literal, sequence, table, view } from "../lexicon/index";

const retentionDays = 30;
const plan = "free";

export const citext = extension`CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public`;

// A backslash in a plain '...' string is an ordinary character in Postgres; in E'...' it escapes.
// Both must reach the server as written, folded or run (#3221's raw strings).
export const email = domain`
  CREATE DOMAIN email_address AS text
    CHECK (VALUE ~ '^[^@\s]+@[^@\s]+$')
    CONSTRAINT not_blank CHECK (VALUE <> E'\t')`;

export const ticketSeq = sequence`CREATE SEQUENCE ticket_seq AS bigint INCREMENT BY 1 START WITH 1000 CACHE 20`;

export const accounts = table`
  CREATE TABLE accounts (
    id      bigint PRIMARY KEY,
    contact ${email} NOT NULL,
    plan    text NOT NULL DEFAULT ${literal(plan)},
    note    text DEFAULT $$it's "quoted" -- not a comment$$,
    created date NOT NULL DEFAULT current_date,
    expires date GENERATED ALWAYS AS (created + ${retentionDays}) STORED,
    CONSTRAINT plan_known CHECK (plan IN ('free', 'pro'))
  ) WITH (fillfactor = 90)`;

// Same file: a materialized view over a table declared above.
export const plans = view`
  CREATE MATERIALIZED VIEW plan_counts AS
  SELECT a.${accounts.columns.plan}, count(*) n
  FROM ${accounts} a
  GROUP BY 1
  WITH NO DATA`;
