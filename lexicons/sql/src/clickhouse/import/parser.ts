/**
 * `chant import schema.sql` for ClickHouse: a file of CREATE statements into
 * the import IR. A statement that is not a CREATE, or does not parse, is an
 * error naming it (`../../files/clickhouse.ts`); none is left out.
 */

import type { TemplateIR, TemplateParser } from "@intentius/chant/import/parser";
import { objectsToIR } from "./ir";
import { readClickHouse } from "../../files/clickhouse";
import { SqlFileError } from "../../files/common";

export class ClickHouseSqlParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const problems: string[] = [];
    const objects = readClickHouse(content, { origin: "the DDL" }, problems);
    if (problems.length > 0) throw new SqlFileError("the DDL", problems);
    return objectsToIR(objects);
  }
}
