import { checkOf } from "./clickhouse-helpers";
import { reportTypeFindings } from "./clickhouse-type-check";

/**
 * SQLCH122: a column type's parameters do not fit the family: parameters on a
 * family that takes none, a required one missing (`FixedString`), too many,
 * or a number outside its range (`Decimal(100, 2)`).
 *
 * The parameter grammar is the `TYPE_PARAMETERS` overlay; no system table
 * holds it.
 */
export const sqlch122 = checkOf({ id: "SQLCH122", description: "A column type's parameters do not fit its family" }, reportTypeFindings("SQLCH122"));
