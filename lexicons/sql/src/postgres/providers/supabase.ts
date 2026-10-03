import { words, type ProviderData } from "./types";

/**
 * Supabase. The extension names are the ones the extensions overview's
 * sidebar documents (plv8, pgjwt, timescaledb and pgsodium are marked
 * deprecated there and left out), read 2026-10-03. The overview's full list
 * is rendered by script and could not be read, so the list is partial:
 * `extensionListComplete` is false and SQLPG004 does not report a name
 * outside it. Roles are the "Supabase roles" section of the roles page. The
 * unsupported operations are the two the roles-and-superuser page names.
 */
export const supabase: ProviderData = {
  provider: "supabase",
  label: "Supabase",
  sources: [
    { url: "https://supabase.com/docs/guides/database/extensions", readOn: "2026-10-03", covers: "allowedExtensions (partial: the documented extension pages)" },
    { url: "https://supabase.com/docs/guides/database/postgres/roles", readOn: "2026-10-03", covers: "reservedRoles; auth, storage and etl schemas" },
    {
      url: "https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/content/guides/database/postgres/roles-superuser.mdx",
      readOn: "2026-10-03",
      covers: "superuser-only statements (the source of https://supabase.com/docs/guides/database/postgres/roles-superuser)",
    },
  ],
  reservedRoles: [
    "postgres", "anon", "authenticator", "authenticated", "service_role", "supabase_auth_admin",
    "supabase_storage_admin", "supabase_etl_admin", "dashboard_user", "supabase_admin",
  ],
  reservedSchemas: ["auth", "storage", "etl"],
  allowedExtensions: words(`
    hypopg http index_advisor pgaudit pgroonga pgrouting pg_cron pg_graphql pg_hashids pg_jsonschema pg_net
    pg_partman pg_plan_filter postgres_fdw vector pg_stat_statements pg_repack postgis pgmq pgtap plpgsql_check
    uuid-ossp rum
  `),
  extensionListComplete: false,
  providerExtensions: ["pg_graphql", "pg_net", "pgmq", "index_advisor"],
  refusedStatements: [
    { id: "copy-program", pattern: /^COPY\b.*\b(FROM|TO) PROGRAM\b/, reason: "COPY ... FROM PROGRAM needs a superuser, which Supabase does not give out" },
    { id: "superuser-role", pattern: /^(CREATE|ALTER) (ROLE|USER)\b.*\bSUPERUSER\b/, reason: "the SUPERUSER attribute cannot be granted on Supabase" },
  ],
  toCheck: [
    "the full extension list (page body is script-rendered): https://supabase.com/docs/guides/database/extensions",
    "reservedSchemas beyond auth, storage and etl (extensions, realtime, graphql, graphql_public, vault, net, supabase_functions, pgbouncer were not read from a page): https://supabase.com/docs/guides/database/postgres/roles",
    "refused statements beyond the two the roles-and-superuser page lists (ALTER SYSTEM was not stated): https://supabase.com/docs/guides/database/postgres/roles-superuser",
    "providerExtensions are inferred from the extension pages' names, not from a statement of ownership",
  ],
};
