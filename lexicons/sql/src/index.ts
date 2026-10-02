// The sql lexicon. Each database dialect is a subpath:
//   @intentius/chant-lexicon-sql/clickhouse
// The root exports the plugin, the serializer and the dialect list.

export { sqlPlugin } from "./plugin";
export { sqlSerializer } from "./serializer";
export { SQL_DIALECTS, type SqlDialect } from "./dialects";
export { sqlConfigSchema, type SqlConfig } from "./config";

// The ClickHouse tags, also exported at the root because the plugin registers
// them as intrinsics (check-lexicon resolves a registered intrinsic against the
// root's exports). Declarations import them from the dialect subpath,
// `@intentius/chant-lexicon-sql/clickhouse`.
export { database, table, view, literal } from "./clickhouse/entities";
