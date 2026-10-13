import { table } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";

export const tenants = table`
  CREATE TABLE ${app}.tenants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    plan       text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'team', 'enterprise')),
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

// The tenant key comes first in every key below. A row is identified by
// (tenant_id, id), so a query scoped to one tenant reads one range of the
// primary key, and a foreign key between tenant tables carries tenant_id
// too: a task cannot point at another tenant's project.
export const users = table`
  CREATE TABLE ${app}.users (
    tenant_id  uuid NOT NULL REFERENCES ${tenants} (${tenants.columns.id}) ON DELETE CASCADE,
    id         bigint GENERATED ALWAYS AS IDENTITY,
    email      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, email)
  );
  COMMENT ON COLUMN ${app}.users.email IS 'Personal data: unique per tenant, lower-cased by the app'`;
