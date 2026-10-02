// The sql lexicon. Each database dialect is a subpath:
//   @intentius/chant-lexicon-sql/clickhouse
// The root exports the plugin, the serializer and the dialect list.

export { sqlPlugin } from "./plugin";
export { sqlSerializer } from "./serializer";
export { SQL_DIALECTS, type SqlDialect } from "./dialects";
export { sqlConfigSchema, type SqlConfig } from "./config";
