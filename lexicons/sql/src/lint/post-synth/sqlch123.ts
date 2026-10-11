import { checkOf } from "./clickhouse-helpers";
import { reportTypeFindings } from "./clickhouse-type-check";

/**
 * SQLCH123: `Nullable` around a type ClickHouse keeps out of it: `Array`,
 * `Map`, `Nested`, `LowCardinality`, `Variant` or another `Nullable`. The
 * server refuses the column ("Nested type ... cannot be inside Nullable
 * type"). `Nullable(Tuple(...))` is left alone: the server takes it when the
 * profile enables `enable_nullable_tuple_type`.
 */
export const sqlch123 = checkOf({ id: "SQLCH123", description: "A Nullable wraps a type ClickHouse does not allow inside Nullable" }, reportTypeFindings("SQLCH123"));
