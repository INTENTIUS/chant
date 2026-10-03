import { words, COMMON_REFUSED, type ProviderData } from "./types";

/**
 * Google Cloud SQL for PostgreSQL. The extension list is the tables on
 * "Configure PostgreSQL extensions" (PostGIS, data type, language and
 * miscellaneous groups), read 2026-10-03. Names are the `CREATE EXTENSION`
 * names: the page's pgAudit is `pgaudit`, pgTAP is `pgtap`, pgvector is
 * `vector`. The page says a customer cannot create their own extensions.
 * Roles are the `cloudsql*` names the Cloud SQL users page lists.
 */
export const cloudSql: ProviderData = {
  provider: "cloud-sql",
  label: "Google Cloud SQL for PostgreSQL",
  sources: [
    { url: "https://cloud.google.com/sql/docs/postgres/extensions", readOn: "2026-10-03", covers: "allowedExtensions, superuser requirement" },
    { url: "https://cloud.google.com/sql/docs/postgres/users", readOn: "2026-10-03", covers: "reservedRoles (the cloudsql* roles)" },
  ],
  reservedRoles: [
    "cloudsqlsuperuser", "cloudsqladmin", "cloudsqlagent", "cloudsqlconnpooladmin", "cloudsqliamgroup",
    "cloudsqliamgroupserviceaccount", "cloudsqliamgroupuser", "cloudsqliamserviceaccount", "cloudsqliamuser",
    "cloudsqlimportexport", "cloudsqlinactiveuser", "cloudsqllogical", "cloudsqlobservability", "cloudsqlreplica",
  ],
  reservedSchemas: [],
  allowedExtensions: words(`
    address_standardizer address_standardizer_data_us amcheck auto_explain autoinc bloom btree_gin btree_gist chkpass
    citext cube dblink dict_int earthdistance fuzzystrmatch google_ml_integration google_read_only_session hll hstore
    insert_username intagg intarray ip4r isn lo ltree moddatetime oracle_fdw orafce pageinspect pg_background pg_bigm
    pg_buffercache pg_cron pg_freespacemap pg_hint_plan pg_ivm pg_partman pg_prewarm pg_proctab pg_qualstats pg_repack
    pg_similarity pg_squeeze pg_stat_statements pg_textsearch pg_trgm pg_visibility pg_wait_sampling pgaudit pgcrypto
    pgfincore pglogical pgrowlocks pgstattuple pgtap pgtt plpgsql plpgsql_check plv8 postgis postgis_raster
    postgis_sfcgal postgis_tiger_geocoder postgis_topology postgres_fdw prefix rdkit roaringbitmap sslinfo tablefunc
    tcn tds_fdw temporal_tables tsm_system_rows tsm_system_time unaccent uuid-ossp vector
  `),
  extensionListComplete: true,
  providerExtensions: ["google_ml_integration", "google_read_only_session"],
  refusedStatements: COMMON_REFUSED,
  toCheck: [
    "anon (the page lists postgresql_anonymizer; the CREATE EXTENSION name was not read): https://cloud.google.com/sql/docs/postgres/extensions",
    "the list is for the newest major; older majors drop some entries",
    "reservedSchemas: no page read names a schema Cloud SQL owns: https://cloud.google.com/sql/docs/postgres/users",
  ],
};
