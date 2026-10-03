import { words, COMMON_REFUSED, type ProviderData } from "./types";

/**
 * Amazon RDS for PostgreSQL. The extension list is the table for major 18 on
 * the "Extensions supported for RDS for PostgreSQL" page, read 2026-10-03;
 * the other majors differ at the edges and are not modelled (the list is the
 * newest GA major's). Package names on that page were mapped to extension
 * names: pgvector is `vector`, h3-pg is `h3` and `h3_postgis`.
 */
export const rds: ProviderData = {
  provider: "rds",
  label: "Amazon RDS for PostgreSQL",
  sources: [
    {
      url: "https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html",
      readOn: "2026-10-03",
      covers: "allowedExtensions (major 18 table)",
    },
    {
      url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.html",
      readOn: "2026-10-03",
      covers: "the master user is a member of rds_superuser, not a superuser",
    },
  ],
  reservedRoles: ["rdsadmin", "rds_superuser", "rds_replication", "rds_password", "rds_iam", "rds_ad", "rdsrepladmin"],
  reservedSchemas: [],
  allowedExtensions: words(`
    address_standardizer address_standardizer_data_us amcheck auto_explain aws_commons aws_lambda aws_s3 bloom
    btree_gin btree_gist citext cube dblink dict_int dict_xsyn earthdistance fuzzystrmatch h3 h3_postgis hll hstore
    hstore_plperl hypopg intagg intarray ip4r isn lo log_fdw ltree mysql_fdw oracle_fdw orafce pageinspect pg_bigm
    pg_buffercache pg_cron pg_freespacemap pg_hint_plan pg_logicalinspect pg_partman pg_prewarm pg_proctab pg_repack
    pg_similarity pg_stat_monitor pg_stat_statements pg_tle pg_transport pg_trgm pg_visibility pg_walinspect pgaudit
    pgcrypto pglogical pgrouting pgrowlocks pgstattuple pgtap plperl plpgsql plprofiler pltcl plv8 postgis
    postgis_raster postgis_tiger_geocoder postgis_topology postgres_fdw prefix rdkit roaringbitmap seg sslinfo
    tablefunc tcn tds_fdw tsm_system_rows tsm_system_time unaccent uuid-ossp vector wal2json
  `),
  extensionListComplete: true,
  providerExtensions: ["aws_commons", "aws_lambda", "aws_s3", "rds_tools", "log_fdw", "pg_transport"],
  refusedStatements: [
    ...COMMON_REFUSED,
    { id: "create-tablespace-location", pattern: /^CREATE TABLESPACE\b/, reason: "RDS refuses tablespaces on a customer-chosen LOCATION" },
  ],
  toCheck: [
    "reservedRoles beyond rds_superuser were not read from a page: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.html",
    "refusedStatements beyond the common three are from the documented master-user model, not a statement list",
    "per-major differences in the extension list",
  ],
};
