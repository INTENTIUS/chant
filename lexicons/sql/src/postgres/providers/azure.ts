import { words, COMMON_REFUSED, type ProviderData } from "./types";

/**
 * Azure Database for PostgreSQL flexible server. The extension list is "List
 * of extensions and modules by name", the entries available on major 18,
 * read 2026-10-03. Besides being on that list, an extension must be allow-
 * listed in the server's `azure.extensions` parameter before CREATE EXTENSION
 * succeeds, and some also need `shared_preload_libraries`; that is server
 * configuration, not something the list says, so it is not modelled.
 * Roles are the three the access-control page names: azure_pg_admin (the
 * pseudo-superuser the administrator belongs to), azuresu (Microsoft's
 * control-plane superuser) and the administrator role the customer names.
 */
export const azure: ProviderData = {
  provider: "azure",
  label: "Azure Database for PostgreSQL flexible server",
  sources: [
    {
      url: "https://learn.microsoft.com/en-us/azure/postgresql/extensions/concepts-extensions-versions",
      readOn: "2026-10-03",
      covers: "allowedExtensions (entries with a major 18 version)",
    },
    {
      url: "https://learn.microsoft.com/en-us/azure/postgresql/security/security-access-control",
      readOn: "2026-10-03",
      covers: "reservedRoles (azure_pg_admin, azuresu); the public schema is owned by azure_pg_admin",
    },
  ],
  reservedRoles: ["azure_pg_admin", "azuresu"],
  reservedSchemas: [],
  allowedExtensions: words(`
    address_standardizer address_standardizer_data_us age amcheck anon auto_explain azure_ai azure_storage bloom
    btree_gin btree_gist citext credcheck cube dblink dict_int dict_xsyn earthdistance fuzzystrmatch hll hstore hypopg
    intagg intarray ip4r isn lo login_hook ltree oracle_fdw orafce pageinspect pgaudit pg_buffercache pg_cron pgcrypto
    pg_diskann pg_failover_slots pg_freespacemap pg_hint_plan pg_ivm pglogical pg_partman pg_partman_bgw pg_prewarm
    pg_repack pgrouting pgrowlocks pg_squeeze pg_stat_statements pgstattuple pg_trgm pg_visibility plpgsql
    plpgsql_check plv8 pointcloud postgis postgis_raster postgis_sfcgal postgis_tiger_geocoder postgis_topology
    postgres_fdw postgres_protobuf rdkit semver session_variable sslinfo tablefunc tdigest tds_fdw temporal_tables
    timescaledb topn tsm_system_rows tsm_system_time unaccent uuid-ossp vector wal2json
  `),
  extensionListComplete: true,
  providerExtensions: ["azure_ai", "azure_storage", "pg_diskann"],
  refusedStatements: [
    ...COMMON_REFUSED,
    { id: "alter-azure-pg-admin", pattern: /^(ALTER|DROP) (ROLE|USER) "?AZURE_PG_ADMIN"?\b/, reason: "azure_pg_admin is a system-managed restricted role and cannot be modified" },
    { id: "grant-to-azure-pg-admin", pattern: /^GRANT\b.*\bTO "?AZURE_PG_ADMIN"?\b/, reason: "azure_pg_admin is a system-managed restricted role; granting membership in it is refused" },
  ],
  toCheck: [
    "the azure.extensions allowlist parameter and shared_preload_libraries needs: https://learn.microsoft.com/en-us/azure/postgresql/extensions/how-to-allow-extensions (the page rendered no body)",
    "reservedSchemas: none read from a page: https://learn.microsoft.com/en-us/azure/postgresql/security/security-access-control",
    "wal2json and pg_partman_bgw are logical-decoding or background-worker modules that may not take CREATE EXTENSION: https://learn.microsoft.com/en-us/azure/postgresql/extensions/concepts-extensions-versions",
    "older majors' lists",
  ],
};
