import { rds } from "./rds";
import { words, type ProviderData } from "./types";

/**
 * Amazon Aurora PostgreSQL. Roles and refused statements are RDS's (Aurora
 * uses the same master-user model). The extension list is the table
 * "Extensions supported for Aurora PostgreSQL 18" on the Aurora release-notes
 * page, read 2026-10-03; package names were mapped to extension names as in
 * rds.ts (h3-pg is `h3`, pgvector is `vector`, pg_roaringbitmap is
 * `roaringbitmap`). Aurora adds apg_plan_mgmt, aurora_stat_utils, aws_ml,
 * pg_ad_mapping and pg_columnmask.
 */
export const aurora: ProviderData = {
  ...rds,
  provider: "aurora",
  label: "Amazon Aurora PostgreSQL",
  sources: [
    {
      url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html",
      readOn: "2026-10-03",
      covers: "allowedExtensions (Aurora PostgreSQL 18 table)",
    },
    ...rds.sources.filter((s) => s.covers !== "allowedExtensions (major 18 table)"),
  ],
  allowedExtensions: words(`
    address_standardizer address_standardizer_data_us amcheck apg_plan_mgmt aurora_stat_utils auto_explain autoinc
    aws_commons aws_lambda aws_ml aws_s3 bloom bool_plperl btree_gin btree_gist citext cube dblink dict_int dict_xsyn
    earthdistance fuzzystrmatch h3 h3_postgis hll hstore hstore_plperl hypopg insert_username intagg intarray ip4r isn
    jsonb_plperl lo log_fdw ltree moddatetime mysql_fdw oracle_fdw orafce pg_ad_mapping pg_bigm pg_buffercache
    pg_columnmask pg_cron pg_freespacemap pg_hint_plan pg_partman pg_prewarm pg_proctab pg_repack pg_similarity
    pg_stat_statements pg_tle pg_trgm pg_visibility pgaudit pgcrypto pgdam pglogical pgrouting pgrowlocks pgstattuple
    pgtap plcoffee plls plperl plpgsql plprofiler pltcl plv8 postgis postgis_raster postgis_tiger_geocoder
    postgis_topology postgres_fdw prefix rdkit rds_activity_stream rds_tools refint roaringbitmap seg sslinfo
    tablefunc tcn tds_fdw tsm_system_rows tsm_system_time unaccent uuid-ossp vector wal2json
  `),
  providerExtensions: [
    "apg_plan_mgmt", "aurora_stat_utils", "aws_commons", "aws_lambda", "aws_ml", "aws_s3", "log_fdw",
    "pg_ad_mapping", "pg_columnmask", "pgdam", "rds_activity_stream", "rds_tools",
  ],
  toCheck: [
    "per-release differences inside major 18, and the other majors' tables",
    "pgdam and pg_columnmask were listed by the page with no description read",
    ...rds.toCheck.filter((t) => !t.startsWith("per-major")),
  ],
};
