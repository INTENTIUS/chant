/**
 * The import generator for every dialect: an IR whose resources are Postgres
 * types goes to the Postgres generator, one of MySQL types to MySQL's, any
 * other to ClickHouse's. A build
 * holds one dialect, and so does an import.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import { ClickHouseGenerator } from "./clickhouse/import/generator";
import { PostgresGenerator } from "./postgres/import/generator";
import { MysqlGenerator } from "./mysql/import/generator";

export const sqlTemplateGenerator: TypeScriptGenerator = {
  ownsLayout: true,
  generate(ir: TemplateIR): GeneratedFile[] {
    if (ir.resources.some((r) => r.type.startsWith("MySQL::"))) return new MysqlGenerator().generate(ir);
    const postgres = ir.resources.some((r) => r.type.startsWith("Postgres::"));
    return (postgres ? new PostgresGenerator() : new ClickHouseGenerator()).generate(ir);
  },
};
