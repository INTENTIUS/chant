import { schema } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema`
  CREATE SCHEMA app;
  COMMENT ON SCHEMA app IS 'A multi-tenant SaaS: every table is keyed by the tenant that owns the row'`;
