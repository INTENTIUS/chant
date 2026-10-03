import { words, COMMON_REFUSED, type ProviderData } from "./types";

/**
 * Neon. The extension list is the "Postgres extensions" table, the entries
 * with a PG18 version (entries marked `-` for PG18, such as plv8, rum and
 * pg_search, are left out), read 2026-10-03. Table names were mapped to
 * `CREATE EXTENSION` names where the page says so: pgvector is `vector`,
 * pg_roaringbitmap is `roaringbitmap`. wal2json is a decoder plugin the page
 * says needs no CREATE EXTENSION, so it is not listed. Reserved roles are
 * the "Reserved role names" list plus neon_service, which the roles page
 * describes as internal.
 */
export const neon: ProviderData = {
  provider: "neon",
  label: "Neon",
  sources: [
    { url: "https://neon.com/docs/extensions/pg-extensions", readOn: "2026-10-03", covers: "allowedExtensions (PG18 column)" },
    { url: "https://neon.com/docs/manage/roles", readOn: "2026-10-03", covers: "reservedRoles, neon_superuser, internal roles" },
    { url: "https://neon.com/docs/reference/compatibility", readOn: "2026-10-03", covers: "no superuser, no tablespaces" },
  ],
  reservedRoles: ["neon_superuser", "cloud_admin", "zenith_admin", "neon_service"],
  reservedSchemas: [],
  allowedExtensions: words(`
    address_standardizer address_standardizer_data_us anon autoinc bloom btree_gin btree_gist citext cube dblink
    dict_int earthdistance fuzzystrmatch h3 h3_postgis hll hstore hypopg insert_username intagg intarray ip4r isn
    lakebase_text lakebase_tokenizer lakebase_vector lo ltree moddatetime neon neon_utils pg_cron pg_graphql
    pg_hashids pg_hint_plan pg_ivm pg_jsonschema pg_partman pg_prewarm pg_repack pg_session_jwt pg_stat_statements
    pg_tiktoken pg_trgm pg_uuidv7 pgcrypto pgjwt pgrag pgrouting pgrowlocks pgstattuple pgtap pgx_ulid plpgsql
    plpgsql_check postgis postgis_raster postgis_sfcgal postgis_tiger_geocoder postgis_topology postgres_fdw prefix
    rdkit refint roaringbitmap seg semver tablefunc tcn timescaledb tsm_system_rows tsm_system_time unaccent
    uuid-ossp vector xml2
  `),
  extensionListComplete: true,
  providerExtensions: ["neon", "neon_utils", "pg_session_jwt", "lakebase_text", "lakebase_tokenizer", "lakebase_vector"],
  refusedStatements: [
    ...COMMON_REFUSED,
    { id: "create-tablespace", pattern: /^CREATE TABLESPACE\b/, reason: "Neon does not support tablespaces" },
    { id: "alter-neon-superuser", pattern: /^(ALTER|DROP) (ROLE|USER) "?NEON_SUPERUSER"?\b/, reason: "neon_superuser is not intended to be modified" },
  ],
  toCheck: [
    "reservedSchemas: none read from a page: https://neon.com/docs/manage/roles",
    "pg_repack needs a paid plan and Neon Support to enable, pg_ivm is not available for new installs: https://neon.com/docs/extensions/pg-extensions",
    "older majors' columns",
  ],
};
