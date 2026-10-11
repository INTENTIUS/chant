import { checkOf } from "./clickhouse-helpers";
import { reportTypeFindings } from "./clickhouse-type-check";

/**
 * SQLCH121: a column type names a family the pinned server does not have
 * (`UInt46`, `uint64`, `Nullabel(String)`), at any depth of the type.
 *
 * The family list is the pinned server's own (`system.data_type_families`),
 * aliases included; a name is case-sensitive unless the catalog marks it
 * case-insensitive.
 */
export const sqlch121 = checkOf({ id: "SQLCH121", description: "A column type names a family the pinned server does not have" }, reportTypeFindings("SQLCH121"));
